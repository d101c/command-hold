import {dispatch, clampPercent, parseWorkspace} from '../dispatch.js';

let pass = 0, fail = 0;
function test(name, fn) {
    Promise.resolve().then(fn).then(() => { pass++; print(`PASS ${name}`); },
        e => { fail++; print(`FAIL ${name}: ${e.message ?? e}`); });
}

class Fake {
    constructor() { this.calls = []; }
}
for (const m of ['openApp', 'closeWindow', 'closeAllWindows', 'setVolume', 'changeVolume', 'setBrightness',
    'changeBrightness', 'darkMode', 'doNotDisturb', 'wifi', 'bluetooth', 'workspace', 'screenshot', 'lock', 'power'])
    Fake.prototype[m] = function (...args) { this.calls.push([m, ...args]); return `${m} ok`; };

test('closed actions call the right method with clamped args', async () => {
    const a = new Fake();
    let r = await dispatch({action: 'open_app', app_id: 'firefox.desktop', name: 'Firefox'}, a);
    if (r.kind !== 'done' || r.say !== 'openApp ok') throw new Error(JSON.stringify(r));
    r = await dispatch({action: 'set_volume', percent: 140}, a);
    r = await dispatch({action: 'switch_workspace', n: '3'}, a);
    r = await dispatch({action: 'switch_workspace', n: 'next'}, a);
    r = await dispatch({action: 'toggle_dark_mode', enable: false}, a);
    r = await dispatch({action: 'toggle_wifi'}, a);
    const expect = [['openApp', 'firefox.desktop', 'Firefox'], ['setVolume', 100], ['workspace', 3],
        ['workspace', 'next'], ['darkMode', false], ['wifi', true]];
    if (JSON.stringify(a.calls) !== JSON.stringify(expect)) throw new Error(JSON.stringify(a.calls));
});

test('a quiet read-only command is run silently, not confirmed', async () => {
    const a = new Fake();
    let r = await dispatch({action: 'run_shell', command: 'df -h ~', quiet: true, needs_confirmation: false}, a);
    if (r.kind !== 'quiet' || r.intent.command !== 'df -h ~') throw new Error(JSON.stringify(r));
    r = await dispatch({action: 'run_shell', command: 'df -h ~', quiet: true, refused: true, reason: 'x'}, a);
    if (r.kind !== 'refused') throw new Error(JSON.stringify(r));
    r = await dispatch({action: 'run_shell', command: 'rm x', quiet: false}, a);
    if (r.kind !== 'confirm') throw new Error(JSON.stringify(r));
});

test('run_shell asks for confirmation, refused stays refused', async () => {
    const a = new Fake();
    let r = await dispatch({action: 'run_shell', command: 'df -h'}, a);
    if (r.kind !== 'confirm' || r.intent.command !== 'df -h') throw new Error(JSON.stringify(r));
    r = await dispatch({action: 'run_shell', command: 'rm -rf /', refused: true, reason: 'deletes the whole system'}, a);
    if (r.kind !== 'refused' || !r.reason) throw new Error(JSON.stringify(r));
    r = await dispatch({action: 'run_shell', command: ''}, a);
    if (r.kind !== 'unknown') throw new Error(JSON.stringify(r));
    if (a.calls.length) throw new Error('nothing must run');
});

test('power always confirms, unknown and answer pass through', async () => {
    const a = new Fake();
    let r = await dispatch({action: 'power', power_action: 'reboot'}, a);
    if (r.kind !== 'confirm') throw new Error(JSON.stringify(r));
    r = await dispatch({action: 'unknown', reason: 'llm-off'}, a);
    if (r.kind !== 'unknown' || r.reason !== 'llm-off') throw new Error(JSON.stringify(r));
    r = await dispatch({action: 'answer', text: '14:02'}, a);
    if (r.kind !== 'answer' || r.text !== '14:02') throw new Error(JSON.stringify(r));
    r = await dispatch(null, a);
    if (r.kind !== 'unknown') throw new Error(JSON.stringify(r));
    r = await dispatch({action: 'fly'}, a);
    if (r.kind !== 'unknown') throw new Error(JSON.stringify(r));
});

test('an action that throws becomes an error result', async () => {
    const a = new Fake();
    a.lock = () => { throw new Error('no screen shield'); };
    const r = await dispatch({action: 'lock'}, a);
    if (r.kind !== 'error' || !r.reason.includes('shield')) throw new Error(JSON.stringify(r));
});

test('helpers', () => {
    if (clampPercent('42') !== 42 || clampPercent(-3) !== 0 || clampPercent('x') !== null) throw new Error('clamp');
    if (parseWorkspace('2') !== 2 || parseWorkspace(0) !== null || parseWorkspace('prev') !== 'prev') throw new Error('ws');
});

const loop = new imports.gi.GLib.MainLoop(null, false);
imports.gi.GLib.timeout_add(imports.gi.GLib.PRIORITY_DEFAULT, 200, () => { loop.quit(); return false; });
loop.run();
print(fail ? `${fail} FAILED` : `all passed (${pass})`);
if (fail) imports.system.exit(1);
