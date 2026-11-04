// Pure routing of an intent (the dict the helper returns) to the actions
// object of the extension. No Shell import: testable with plain gjs.
//
// `actions` implements: openApp(id, name), closeWindow(), closeAllWindows(),
// setVolume(pct), changeVolume(delta), setBrightness(pct),
// changeBrightness(delta), darkMode(on), doNotDisturb(on), wifi(on),
// bluetooth(on), workspace(n), screenshot(target), lock(), power(kind).
// Each returns a short string for the pill (or a Promise of one).
//
// dispatch() returns {kind: 'done', say} | {kind: 'confirm', intent} |
// {kind: 'quiet', intent} (a read-only command: run silently, show the output) |
// {kind: 'refused', reason} | {kind: 'unknown', reason} | {kind: 'answer', text}.

const CLOSED = {
    open_app: (a, i) => a.openApp(i.app_id, i.name),
    close_window: a => a.closeWindow(),
    close_all_windows: a => a.closeAllWindows(),
    set_volume: (a, i) => a.setVolume(clampPercent(i.percent)),
    change_volume: (a, i) => a.changeVolume(Number(i.delta) || 0),
    set_brightness: (a, i) => a.setBrightness(clampPercent(i.percent)),
    change_brightness: (a, i) => a.changeBrightness(Number(i.delta) || 0),
    toggle_dark_mode: (a, i) => a.darkMode(i.enable !== false),
    toggle_dnd: (a, i) => a.doNotDisturb(i.enable !== false),
    toggle_wifi: (a, i) => a.wifi(i.enable !== false),
    toggle_bluetooth: (a, i) => a.bluetooth(i.enable !== false),
    switch_workspace: (a, i) => a.workspace(parseWorkspace(i.n)),
    screenshot: (a, i) => a.screenshot(i.target || 'screen'),
    lock: a => a.lock(),
};

export function clampPercent(v) {
    const n = Number(v);
    if (!Number.isFinite(n))
        return null;
    return Math.max(0, Math.min(100, Math.round(n)));
}

export function parseWorkspace(n) {
    if (n === 'next' || n === 'prev')
        return n;
    const i = parseInt(n, 10);
    return Number.isFinite(i) && i >= 1 ? i : null;
}

export async function dispatch(intent, actions) {
    const action = intent?.action ?? 'unknown';
    if (action === 'unknown')
        return {kind: 'unknown', reason: intent?.reason ?? ''};
    if (action === 'answer')
        return {kind: 'answer', text: String(intent.text ?? '')};
    if (action === 'run_shell') {
        if (intent.refused)
            return {kind: 'refused', reason: intent.reason ?? ''};
        if (!intent.command)
            return {kind: 'unknown', reason: 'empty command'};
        return {kind: intent.quiet === true ? 'quiet' : 'confirm', intent};
    }
    if (action === 'power')
        return {kind: 'confirm', intent};
    const fn = CLOSED[action];
    if (!fn)
        return {kind: 'unknown', reason: `unsupported ${action}`};
    try {
        const say = await fn(actions, intent);
        return {kind: 'done', say: say ?? ''};
    } catch (e) {
        return {kind: 'error', reason: e?.message ?? String(e)};
    }
}
