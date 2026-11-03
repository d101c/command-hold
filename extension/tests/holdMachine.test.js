// Run: gjs -m extension/tests/holdMachine.test.js
import {HoldMachine, IDLE, PENDING, HOLD, TOGGLE} from '../holdMachine.js';

let failures = 0;
function test(name, fn) {
    try {
        fn();
        print(`PASS ${name}`);
    } catch (e) {
        failures++;
        print(`FAIL ${name}: ${e.message}`);
    }
}
function check(cond, msg) {
    if (!cond)
        throw new Error(msg);
}
const kinds = actions => actions.map(a => a[0]).join(',');

test('shortcut starts and watches the modifier', () => {
    const m = new HoldMachine();
    check(kinds(m.shortcut(0)) === 'start,watch', 'start+watch');
    check(m.state === PENDING, 'pending');
});

test('held past the tap threshold = hold mode, release stops', () => {
    const m = new HoldMachine({tapMs: 350});
    m.shortcut(0);
    check(kinds(m.modifier(100, true)) === '', 'nothing yet');
    check(m.state === PENDING, 'still pending');
    m.modifier(400, true);
    check(m.state === HOLD, 'hold');
    check(kinds(m.modifier(2000, false)) === 'unwatch,stop', 'release stops');
    check(m.state === IDLE, 'idle');
});

test('quick tap = toggle mode, second shortcut stops', () => {
    const m = new HoldMachine({tapMs: 350});
    m.shortcut(0);
    check(kinds(m.modifier(120, false)) === 'unwatch', 'tap -> unwatch only');
    check(m.state === TOGGLE, 'toggle');
    check(kinds(m.modifier(5000, false)) === '', 'modifier ignored in toggle');
    check(kinds(m.shortcut(6000)) === 'stop', 'second press stops');
    check(m.state === IDLE, 'idle');
});

test('escape cancels', () => {
    const m = new HoldMachine();
    m.shortcut(0);
    m.modifier(100, false);
    check(kinds(m.escape()) === 'cancel', 'cancel');
    check(m.state === IDLE, 'idle');
    check(kinds(m.escape()) === '', 'escape when idle does nothing');
});

test('escape while holding also unwatches', () => {
    const m = new HoldMachine();
    m.shortcut(0);
    m.modifier(500, true);
    check(kinds(m.escape()) === 'unwatch,cancel', 'unwatch+cancel');
});

test('hold-only mode: early release still stops', () => {
    const m = new HoldMachine({mode: 'hold', tapMs: 350});
    m.shortcut(0);
    check(kinds(m.modifier(100, false)) === 'unwatch,stop', 'stops');
});

test('toggle-only mode never watches', () => {
    const m = new HoldMachine({mode: 'toggle'});
    check(kinds(m.shortcut(0)) === 'start', 'start only');
    check(m.state === TOGGLE, 'toggle');
    check(kinds(m.shortcut(1)) === 'stop', 'stop');
});

test('engine stopped on its own: no stop sent back', () => {
    const m = new HoldMachine();
    m.shortcut(0);
    m.modifier(500, true);
    check(kinds(m.external('engine')) === 'unwatch', 'just unwatch');
    check(m.state === IDLE, 'idle');
});

test('focus change stops', () => {
    const m = new HoldMachine();
    m.shortcut(0);
    m.modifier(100, false);
    check(kinds(m.external('focus')) === 'stop', 'stop');
});

print(failures ? `${failures} failure(s)` : 'all passed');
if (failures)
    imports.system.exit(1);
