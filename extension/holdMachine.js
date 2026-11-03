// Dictation gesture state machine, free of Shell imports so it can be tested
// with plain gjs. Same spirit as Accent Hold's holdMachine.js.
//
// The shortcut (e.g. <Super>x) starts listening at once. What happens next
// depends on the modifier:
//   - still held `tapMs` after the activation  -> HOLD mode: releasing the
//     modifier stops the dictation (like holding Fn on macOS);
//   - released before `tapMs`                   -> TOGGLE mode: hands-free,
//     until the shortcut is pressed again, Escape, or a long silence.
//
// Inputs are plain events; outputs are action lists the caller executes:
//   ['start']        begin a session (engine Start)
//   ['stop']         finish (engine Stop)
//   ['cancel']       abort (engine Cancel)
//   ['watch']        start polling the modifier state
//   ['unwatch']      stop polling

export const IDLE = 'idle';
export const PENDING = 'pending';   // listening, gesture not decided yet
export const HOLD = 'hold';
export const TOGGLE = 'toggle';

export class HoldMachine {
    // mode: 'auto' | 'hold' | 'toggle'
    constructor({mode = 'auto', tapMs = 350} = {}) {
        this.mode = mode;
        this.tapMs = tapMs;
        this.state = IDLE;
        this._t0 = 0;
    }

    // The shortcut was activated at time `now` (ms).
    shortcut(now) {
        if (this.state === IDLE) {
            this._t0 = now;
            if (this.mode === 'toggle') {
                this.state = TOGGLE;
                return [['start']];
            }
            this.state = PENDING;
            return [['start'], ['watch']];
        }
        // A second activation while listening always stops.
        return this._end('stop');
    }

    // The modifier state was polled at time `now`: `held` is true while it is
    // still down.
    modifier(now, held) {
        if (this.state === PENDING) {
            if (held) {
                if (now - this._t0 >= this.tapMs) {
                    this.state = HOLD;
                }
                return [];
            }
            // Released: tap (toggle) or an early release in hold-only mode.
            if (this.mode === 'hold' || now - this._t0 >= this.tapMs)
                return this._end('stop');
            this.state = TOGGLE;
            return [['unwatch']];
        }
        if (this.state === HOLD && !held)
            return this._end('stop');
        return [];
    }

    escape() {
        if (this.state === IDLE)
            return [];
        return this._end('cancel');
    }

    // Focus moved, engine stopped on its own (silence, end of audio)...
    external(reason = 'stop') {
        if (this.state === IDLE)
            return [];
        return this._end(reason === 'cancel' ? 'cancel' : 'stop', reason !== 'engine');
    }

    _end(action, tellEngine = true) {
        const wasWatching = this.state === PENDING || this.state === HOLD;
        this.state = IDLE;
        const actions = [];
        if (wasWatching)
            actions.push(['unwatch']);
        if (tellEngine)
            actions.push([action]);
        return actions;
    }
}
