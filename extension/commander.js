import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import IBus from 'gi://IBus';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Actions} from './actions.js';
import {confirm} from './confirmDialog.js';
import {dispatch} from './dispatch.js';
import {EngineClient} from './engine.js';
import {HoldMachine, IDLE, TOGGLE} from './holdMachine.js';
import {Hud} from './hud.js';
import {installKeyHook} from './keyHook.js';
import {VoiceClient} from './voice.js';

// The whole gesture: hold the shortcut, the Voice Hold engine listens, the
// text goes to command-hold-engine, the intent is executed here or
// confirmed first. One session at a time.

const WATCH_MS = 50;
const END_GUARD_MS = 3000;
const SHOW_RESULT_MS = 2500;
const SHOW_ANSWER_MS = 6000;
const SHOW_JOB_MS = 4000;

export function modifierMask(accel) {
    let mask = 0;
    const s = accel.toLowerCase();
    if (s.includes('<super>') || s.includes('<mod4>'))
        mask |= Clutter.ModifierType.MOD4_MASK;
    if (s.includes('<control>') || s.includes('<ctrl>') || s.includes('<primary>'))
        mask |= Clutter.ModifierType.CONTROL_MASK;
    if (s.includes('<alt>') || s.includes('<mod1>'))
        mask |= Clutter.ModifierType.MOD1_MASK;
    if (s.includes('<shift>'))
        mask |= Clutter.ModifierType.SHIFT_MASK;
    return mask;
}

export class Commander {
    constructor(settings, iconPath, gettext) {
        this._settings = settings;
        this._ = gettext || (s => s);
        this._machine = new HoldMachine(this._machineOptions());
        this._hud = new Hud(iconPath, this._);
        this._actions = new Actions(this._);
        this._voice = new VoiceClient({
            Owner: has => this._onVoiceOwner(has),
            State: s => this._onState(s),
            Level: v => this._hud.level(v),
            Speech: b => this._onSpeech(b),
            Final: t => this._onFinal(t),
            Stopped: r => this._onStopped(r),
            Error: m => this._onVoiceError(m),
        });
        this._engine = new EngineClient({
            Owner: has => this._onEngineOwner(has),
            Job: (id, state, code, tail) => this._onJob(id, state, code, tail),
        });
        this._watchId = 0;
        this._silenceId = 0;
        this._guardId = 0;
        this._mask = modifierMask(settings.get_strv('command-shortcut')[0] ?? '');
        this._session = null;   // {ending, texts: [], window}
        this._busy = false;     // interpreting / confirming / executing
        this._jobs = new Map(); // id -> command

        settings.connectObject(
            'changed::mode', () => this._reconfigure(),
            'changed::tap-ms', () => this._reconfigure(),
            'changed::command-shortcut', () => this._reconfigure(),
            this);
        this._keyHook = installKeyHook(IBus.InputContext.prototype, (keyval, state) => this._filterKey(keyval, state));
    }

    destroy() {
        this._run(this._machine.external('cancel'));
        this._endSession();
        this._keyHook.uninstall();
        this._keyHook = null;
        this._settings.disconnectObject(this);
        this._stopWatch();
        this._voice.destroy();
        this._voice = null;
        this._engine.destroy();
        this._engine = null;
        this._actions.destroy();
        this._actions = null;
        this._hud.destroy();
        this._hud = null;
        this._settings = null;
    }

    _machineOptions() {
        return {
            mode: this._settings.get_string('mode'),
            tapMs: this._settings.get_int('tap-ms'),
        };
    }

    _reconfigure() {
        const o = this._machineOptions();
        this._machine.mode = o.mode;
        this._machine.tapMs = o.tapMs;
        this._mask = modifierMask(this._settings.get_strv('command-shortcut')[0] ?? '');
    }

    // -- entry point -----------------------------------------------------------

    shortcut() {
        if (this._busy)
            return;
        this._run(this._machine.shortcut(GLib.get_monotonic_time() / 1000));
    }

    get _live() {
        return !!this._session && !this._session.ending;
    }

    _run(actions) {
        for (const [kind] of actions) {
            if (kind === 'start')
                this._start();
            else if (kind === 'stop')
                this._stop();
            else if (kind === 'cancel')
                this._cancel();
            else if (kind === 'watch')
                this._startWatch();
            else if (kind === 'unwatch')
                this._stopWatch();
        }
        if (this._machine.state === TOGGLE && this._live) {
            this._hud.status(this._listeningHint(), 'listening');
            this._armSilence();
        }
    }

    // -- session --------------------------------------------------------------

    _start() {
        if (this._session)
            return;
        const session = {ending: false, texts: [], window: global.display.focus_window};
        this._session = session;
        if (this._settings.get_boolean('show-hud'))
            this._hud.show(this._('Starting…'), 'loading');
        this._voice.start({'silence-stop-s': 0}).then(err => {
            if (!err || this._session !== session || session.ending)
                return;
            this._run(this._machine.external('engine'));
            this._endSession();
            this._showVoiceError(err);
        });
    }

    _stop() {
        const session = this._session;
        if (!session || session.ending)
            return;
        session.ending = true;
        this._stopSilence();
        this._hud.status(this._('…'), 'listening');
        this._voice.stop().then(err => {
            if (this._session !== session)
                return;
            if (err) {
                this._showVoiceError(err);
                this._onStopped('error');
                return;
            }
            this._armGuard(session);
        });
    }

    _cancel() {
        const session = this._session;
        if (!session)
            return;
        this._stopSilence();
        this._hud.hideNow();
        if (session.ending)
            return;
        session.ending = true;
        session.cancelled = true;
        this._voice.cancel().then(err => {
            if (this._session !== session)
                return;
            if (err)
                this._onStopped('cancel');
            else
                this._armGuard(session);
        });
    }

    _endSession() {
        this._cancelGuard();
        this._stopSilence();
        this._session = null;
    }

    _armGuard(session) {
        this._cancelGuard();
        this._guardId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, END_GUARD_MS, () => {
            this._guardId = 0;
            if (this._session === session)
                this._onStopped('error');
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelGuard() {
        if (this._guardId) {
            GLib.source_remove(this._guardId);
            this._guardId = 0;
        }
    }

    // -- modifier polling / silence --------------------------------------------

    _startWatch() {
        this._stopWatch();
        if (!this._mask) {
            this._run(this._machine.modifier(GLib.get_monotonic_time() / 1000, false));
            return;
        }
        this._watchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WATCH_MS, () => {
            const [, , mods] = global.get_pointer();
            this._run(this._machine.modifier(GLib.get_monotonic_time() / 1000, (mods & this._mask) !== 0));
            return this._watchId ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
    }

    _stopWatch() {
        if (this._watchId) {
            GLib.source_remove(this._watchId);
            this._watchId = 0;
        }
    }

    _armSilence() {
        this._stopSilence();
        const s = this._settings.get_double('silence-stop-s');
        if (s <= 0 || this._machine.state !== TOGGLE)
            return;
        this._silenceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(s * 1000), () => {
            this._silenceId = 0;
            this._run(this._machine.external('silence'));
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopSilence() {
        if (this._silenceId) {
            GLib.source_remove(this._silenceId);
            this._silenceId = 0;
        }
    }

    // -- voice events -------------------------------------------------------------

    _listeningHint() {
        return this._machine.state === TOGGLE
            ? this._('Listening — press again or Esc to stop')
            : this._('Listening — release to run');
    }

    _onVoiceOwner(hasOwner) {
        if (hasOwner || !this._session)
            return;
        this._hud.error(this._('Voice engine stopped unexpectedly'));
        this._onStopped('error');
    }

    _onState(state) {
        if (!this._live)
            return;
        if (state === 'loading')
            this._hud.status(this._('Loading the model… speak, nothing is lost'), 'loading');
        else if (state === 'listening')
            this._hud.status(this._listeningHint(), 'listening');
        else if (state === 'decoding')
            this._hud.status(this._('…'), 'listening');
    }

    _onSpeech(speaking) {
        if (!this._live)
            return;
        if (speaking)
            this._stopSilence();
        else
            this._armSilence();
    }

    _onFinal(text) {
        if (!this._session)
            return;
        const t = text.trim();
        if (!t)
            return;
        this._session.texts.push(t);
        this._hud.live(this._session.texts.join(' '));
    }

    _onStopped(reason) {
        const session = this._session;
        if (!session)
            return;
        const wasEnding = session.ending;
        this._endSession();
        if (!wasEnding)
            this._run(this._machine.external('engine'));
        if (session.cancelled || reason === 'cancel') {
            this._hud.hideNow();
            return;
        }
        const text = session.texts.join(' ').trim();
        if (reason === 'error') {
            this._hud.hide(2500);
            return;
        }
        if (!text) {
            this._hud.status(this._('Nothing heard'), '');
            this._hud.hide(1500);
            return;
        }
        this._interpret(text, session.window);
    }

    _onVoiceError(message) {
        if (message === 'models-missing')
            this._showVoiceError('models-missing');
        else
            this._hud.error(message.startsWith('audio') ? this._('Microphone unavailable') : message);
        if (this._session)
            this._armGuard(this._session);
    }

    _showVoiceError(code) {
        const texts = {
            'not-installed': this._('Voice Hold engine not installed — see the settings'),
            'spawn-failed': this._('Voice Hold engine failed to start — see the settings'),
            'models-missing': this._('Speech models missing — run: voice-hold-engine setup'),
            'timeout': this._('Voice engine did not answer'),
            'busy': this._('Voice engine busy — a dictation is running'),
            'no-proxy': this._('D-Bus unavailable'),
        };
        if (code === 'cancelled')
            return;
        this._hud.error(texts[code] ?? code);
    }

    // -- understanding and execution ------------------------------------------

    async _interpret(text, window) {
        this._busy = true;
        this._hud.status(this._('Thinking…'), 'loading');
        const options = {
            'llm': this._settings.get_boolean('llm'),
            'llm-model': this._settings.get_string('llm-model'),
            'llm-url': this._settings.get_string('llm-url'),
            'work-dir': this._settings.get_string('work-dir'),
        };
        try {
            const res = await this._engine.interpret(text, options);
            if (!res.ok) {
                this._showEngineError(res.error);
                return;
            }
            await this._execute(res.value, text, window);
        } catch (e) {
            logError(e, 'command-hold: interpret');
            this._hud.error(e.message);
        } finally {
            this._busy = false;
        }
    }

    async _execute(intent, text, window) {
        const result = await dispatch(intent, this._actions);
        switch (result.kind) {
        case 'done':
            this._hud.status(result.say || this._('Done'), 'listening');
            this._hud.hide(SHOW_RESULT_MS);
            return;
        case 'answer':
            this._hud.status(result.text, 'listening');
            this._hud.hide(SHOW_ANSWER_MS);
            return;
        case 'refused':
            this._hud.error(this._('Refused: %s').format(result.reason));
            return;
        case 'error':
            this._hud.error(result.reason);
            return;
        case 'unknown':
            this._hud.error(this._unknownText(result.reason, text));
            return;
        case 'confirm':
            break;
        }
        this._hud.hideNow();
        const i = result.intent;
        if (i.action === 'power') {
            const names = {suspend: this._('Suspend'), reboot: this._('Restart'), shutdown: this._('Power off'), logout: this._('Log out')};
            const ok = await confirm({
                title: this._('Command Hold heard: “%s”').format(text),
                command: names[i.power_action] ?? i.power_action,
                warning: '',
                runLabel: names[i.power_action] ?? this._('Run'),
                cancelLabel: this._('Cancel'),
            });
            if (ok)
                this._actions.power(i.power_action);
            return;
        }
        const ok = await confirm({
            title: this._('Command Hold heard: “%s”').format(text),
            command: `$ ${i.command}`,
            warning: i.warning ? this._('Warning: this %s.').format(i.warning) : '',
            runLabel: this._('Run'),
            cancelLabel: this._('Cancel'),
        });
        if (!ok)
            return;
        this._hud.show(this._('Running…'), 'loading');
        const run = await this._engine.run(i.command, i.cwd ?? '');
        if (!run.ok) {
            this._showEngineError(run.error);
            return;
        }
        this._jobs.set(run.value, i.command);
    }

    _unknownText(reason, text) {
        if (reason === 'llm-off')
            return this._('Not a GNOME action, and the local LLM is off — “%s”').format(text);
        if (reason === 'llm-unavailable')
            return this._('Not a GNOME action, and Ollama is not answering — “%s”').format(text);
        if (reason === 'nothing to do')
            return this._('OK');
        return this._('Not understood: “%s”').format(text);
    }

    _onEngineOwner(hasOwner) {
        if (hasOwner)
            return;
        if (this._busy)
            this._hud.error(this._('Command engine stopped unexpectedly'));
        for (const id of this._jobs.keys())
            this._jobs.delete(id);
    }

    _onJob(id, state, code, tail) {
        if (!this._jobs.has(id))
            return;
        if (state === 'running') {
            this._hud.show(this._('Running…'), 'loading');
            return;
        }
        this._jobs.delete(id);
        const detail = tail ? ` — ${tail}` : '';
        if (state === 'done')
            this._hud.show(this._('Done ✓%s').format(detail), 'listening');
        else
            this._hud.show(this._('Failed ✗ (exit %d)%s').format(code, detail), 'error');
        this._hud.hide(SHOW_JOB_MS);
    }

    _showEngineError(code) {
        const texts = {
            'not-installed': this._('Command engine not installed — see the settings'),
            'spawn-failed': this._('Command engine failed to start — see the settings'),
            'no-terminal': this._('No terminal found (install Ptyxis or GNOME Terminal)'),
            'timeout': this._('Command engine did not answer'),
            'no-proxy': this._('D-Bus unavailable'),
        };
        if (code === 'cancelled')
            return;
        if (code.startsWith('refused: ')) {
            this._hud.error(this._('Refused: %s').format(code.slice(9)));
            return;
        }
        this._hud.error(texts[code] ?? code);
    }

    // -- Escape inside text fields (hands-free mode) ----------------------------

    _filterKey(keyval, state) {
        if (!this._machine || this._machine.state === IDLE)
            return false;
        if (keyval !== Clutter.KEY_Escape)
            return false;
        if ((state & IBus.ModifierType.RELEASE_MASK) === 0)
            this._run(this._machine.escape());
        return true;
    }
}
