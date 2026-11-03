import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// D-Bus client of the Voice Hold engine (org.griffit.VoiceHold), which does
// the listening for us: one speech model loaded on the machine, shared by
// both extensions. Same shape as Voice Hold's own engine.js.

export const BUS_NAME = 'org.griffit.VoiceHold';
export const OBJECT_PATH = '/org/griffit/VoiceHold';
export const INTERFACE = 'org.griffit.VoiceHold';
const BUSY_ERROR = 'org.griffit.VoiceHold.Error.Busy';

const IFACE_XML = `
<node>
  <interface name="${INTERFACE}">
    <method name="Start"><arg type="a{sv}" name="options" direction="in"/></method>
    <method name="Stop"/>
    <method name="Cancel"/>
    <method name="Status"><arg type="a{sv}" name="status" direction="out"/></method>
    <signal name="State"><arg type="s" name="state"/></signal>
    <signal name="Source"><arg type="s" name="description"/></signal>
    <signal name="Level"><arg type="d" name="level"/></signal>
    <signal name="Speech"><arg type="b" name="speaking"/></signal>
    <signal name="Partial"><arg type="s" name="text"/></signal>
    <signal name="Final"><arg type="s" name="text"/></signal>
    <signal name="Stopped"><arg type="s" name="reason"/></signal>
    <signal name="Error"><arg type="s" name="message"/></signal>
  </interface>
</node>`;

const Proxy = Gio.DBusProxy.makeProxyWrapper(IFACE_XML);
const CALL_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 60000;

export class VoiceClient {
    // handlers: {Owner, State, Level, Speech, Partial, Final, Stopped, Error}
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
                        logError(error, 'command-hold: voice proxy');
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
            logError(e, 'command-hold: voice proxy');
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

    _call(method, args = null, timeout = CALL_TIMEOUT_MS) {
        return new Promise(resolve => {
            if (!this._proxy) {
                resolve('no-proxy');
                return;
            }
            this._proxy.call(method, args, Gio.DBusCallFlags.NONE, timeout, this._cancellable,
                (proxy, res) => {
                    try {
                        proxy.call_finish(res);
                        resolve(null);
                    } catch (e) {
                        resolve(classifyError(e, 'voice'));
                    }
                });
        });
    }

    start(options) {
        const dict = {};
        for (const [k, v] of Object.entries(options)) {
            if (typeof v === 'boolean')
                dict[k] = GLib.Variant.new_boolean(v);
            else if (typeof v === 'number')
                dict[k] = GLib.Variant.new_double(v);
            else
                dict[k] = GLib.Variant.new_string(String(v));
        }
        return this._call('Start', new GLib.Variant('(a{sv})', [dict]));
    }

    stop() {
        return this._call('Stop', null, STOP_TIMEOUT_MS);
    }

    cancel() {
        return this._call('Cancel');
    }
}

// Shared by voice.js and engine.js: a short code for an error, or
// `error: message`.
export function classifyError(e, who, log = true) {
    const name = Gio.DBusError.is_remote_error(e) ? Gio.DBusError.get_remote_error(e) : '';
    if (name === 'org.freedesktop.DBus.Error.ServiceUnknown' ||
        name === 'org.freedesktop.DBus.Error.NameHasNoOwner')
        return 'not-installed';
    if (name.startsWith('org.freedesktop.DBus.Error.Spawn'))
        return 'spawn-failed';
    if (name === BUSY_ERROR)
        return 'busy';
    if (name === 'org.griffit.CommandHold.Error.NoTerminal')
        return 'no-terminal';
    if (name === 'org.griffit.CommandHold.Error.Refused')
        return `refused: ${e.message.replace(/^.*?: /, '')}`;
    if (name === 'org.freedesktop.DBus.Error.NoReply' ||
        name === 'org.freedesktop.DBus.Error.Timeout' ||
        e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT))
        return 'timeout';
    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        return 'cancelled';
    if (log)
        logError(e, `command-hold: ${who} call`);
    return `error: ${e.message}`;
}
