import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {classifyError} from './voice.js';

// D-Bus client of command-hold-engine (org.griffit.CommandHold): turns a
// sentence into an intent, runs confirmed shell commands, reports jobs.

export const BUS_NAME = 'org.griffit.CommandHold';
export const OBJECT_PATH = '/org/griffit/CommandHold';
export const INTERFACE = 'org.griffit.CommandHold';

const IFACE_XML = `
<node>
  <interface name="${INTERFACE}">
    <method name="Interpret">
      <arg type="s" name="text" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="a{sv}" name="intent" direction="out"/>
    </method>
    <method name="Run">
      <arg type="s" name="command" direction="in"/>
      <arg type="s" name="cwd" direction="in"/>
      <arg type="s" name="job_id" direction="out"/>
    </method>
    <method name="Status"><arg type="a{sv}" name="status" direction="out"/></method>
    <method name="Prepare"/>
    <method name="ReloadApps"/>
    <method name="Quit"/>
    <signal name="Job">
      <arg type="s" name="id"/><arg type="s" name="state"/><arg type="i" name="exit_code"/><arg type="s" name="tail"/>
    </signal>
  </interface>
</node>`;

const Proxy = Gio.DBusProxy.makeProxyWrapper(IFACE_XML);
// Cold start of the model can take 90 s on the engine side; the pill says
// "Thinking…" meanwhile.
const INTERPRET_TIMEOUT_MS = 100000;
const CALL_TIMEOUT_MS = 10000;

export class EngineClient {
    // handlers: {Owner, Job}
    constructor(handlers) {
        this._handlers = handlers;
        this._proxy = null;
        this._signalId = 0;
        this._ownerId = 0;
        this._cancellable = new Gio.Cancellable();
        try {
            this._proxy = new Proxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH,
                (proxy, error) => {
                    if (error && !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(error, 'command-hold: engine proxy');
                }, this._cancellable,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION);
            this._signalId = this._proxy.connect('g-signal', (_p, _sender, name, params) => {
                const fn = this._handlers[name];
                if (fn)
                    fn(...params.deepUnpack());
            });
            this._ownerId = this._proxy.connect('notify::g-name-owner', proxy => {
                this._handlers.Owner?.(!!proxy.g_name_owner);
            });
        } catch (e) {
            logError(e, 'command-hold: engine proxy');
        }
    }

    destroy() {
        this._cancellable.cancel();
        if (this._proxy) {
            if (this._signalId)
                this._proxy.disconnect(this._signalId);
            if (this._ownerId)
                this._proxy.disconnect(this._ownerId);
        }
        this._signalId = 0;
        this._ownerId = 0;
        this._proxy = null;
        this._handlers = {};
    }

    // Resolves to {ok: true, value} or {ok: false, error: code}.
    _call(method, args, timeout, unpack) {
        return new Promise(resolve => {
            if (!this._proxy) {
                resolve({ok: false, error: 'no-proxy'});
                return;
            }
            this._proxy.call(method, args, Gio.DBusCallFlags.NONE, timeout, this._cancellable,
                (proxy, res) => {
                    try {
                        const ret = proxy.call_finish(res);
                        resolve({ok: true, value: unpack ? unpack(ret) : null});
                    } catch (e) {
                        resolve({ok: false, error: classifyError(e, 'engine')});
                    }
                });
        });
    }

    // options: {llm: bool, 'llm-model': str, 'llm-url': str, 'work-dir': str}
    interpret(text, options) {
        const dict = {};
        for (const [k, v] of Object.entries(options)) {
            dict[k] = typeof v === 'boolean' ? GLib.Variant.new_boolean(v) : GLib.Variant.new_string(String(v));
        }
        return this._call('Interpret', new GLib.Variant('(sa{sv})', [text, dict]), INTERPRET_TIMEOUT_MS,
            ret => {
                const [dictOut] = ret.deepUnpack();
                const intent = {};
                for (const [k, v] of Object.entries(dictOut))
                    intent[k] = v.deepUnpack();
                return intent;
            });
    }

    // Load the model and prime its prompt cache while the user is talking.
    // Starts the engine when it is not running. Fire and forget.
    prepare() {
        return this._call('Prepare', null, CALL_TIMEOUT_MS);
    }

    run(command, cwd) {
        return this._call('Run', new GLib.Variant('(ss)', [command, cwd]), CALL_TIMEOUT_MS,
            ret => ret.deepUnpack()[0]);
    }
}

// Status of the helper without starting it (prefs, indicator): resolves to
// the status dict, null when not running (autoStart false), or {error}.
export function engineStatus(cancellable = null, {autoStart = true} = {}) {
    return new Promise(resolve => {
        const flags = autoStart ? Gio.DBusCallFlags.NONE : Gio.DBusCallFlags.NO_AUTO_START;
        try {
            Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, INTERFACE, 'Status', null,
                new GLib.VariantType('(a{sv})'), flags, CALL_TIMEOUT_MS, cancellable,
                (conn, res) => {
                    try {
                        const [dict] = conn.call_finish(res).deepUnpack();
                        const out = {};
                        for (const [k, v] of Object.entries(dict))
                            out[k] = v.deepUnpack();
                        resolve(out);
                    } catch (e) {
                        const code = classifyError(e, 'engine', false);
                        resolve(!autoStart && code === 'not-installed' ? null : {error: code, message: e.message});
                    }
                });
        } catch (e) {
            resolve({error: 'error', message: e.message});
        }
    });
}
