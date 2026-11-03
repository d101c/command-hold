import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

// The GNOME side of every closed action. Everything here runs inside the
// shell through its own APIs; nothing is spawned. Each method returns the
// short line shown in the pill.

const POWER_IFACE = 'org.gnome.SettingsDaemon.Power.Screen';
const POWER_NAME = 'org.gnome.SettingsDaemon.Power';
const POWER_PATH = '/org/gnome/SettingsDaemon/Power';

export class Actions {
    constructor(gettext) {
        this._ = gettext || (s => s);
        this._mixer = null;
        this._nm = null;
        this._bt = null;
    }

    destroy() {
        if (this._mixer) {
            this._mixer.close();
            this._mixer = null;
        }
        this._nm = null;
        this._bt = null;
    }

    // -- applications and windows ------------------------------------------

    openApp(id, name) {
        const info = Gio.DesktopAppInfo.new(id);
        if (!info)
            throw new Error(this._('No application "%s"').format(name || id));
        info.launch([], global.create_app_launch_context(0, -1));
        return this._('Opening %s').format(info.get_display_name() || name);
    }

    closeWindow() {
        const w = global.display.focus_window;
        if (!w)
            return this._('No window to close');
        const title = w.get_title() || '';
        w.delete(global.get_current_time());
        return this._('Closing %s').format(title);
    }

    closeAllWindows() {
        const ws = global.workspace_manager.get_active_workspace();
        const wins = global.get_window_actors().map(a => a.meta_window)
            .filter(w => w && w.window_type === Meta.WindowType.NORMAL && w.located_on_workspace(ws));
        for (const w of wins)
            w.delete(global.get_current_time());
        return this._('Closing %d windows').format(wins.length);
    }

    // -- sound ------------------------------------------------------------------

    _sink() {
        return new Promise((resolve, reject) => {
            if (!this._mixer) {
                this._mixer = new Gvc.MixerControl({name: 'Command Hold'});
                this._mixer.open();
            }
            const ready = () => {
                const s = this._mixer.get_default_sink();
                if (s)
                    resolve(s);
                else
                    reject(new Error(this._('No sound output')));
            };
            if (this._mixer.get_state() === Gvc.MixerControlState.READY) {
                ready();
                return;
            }
            const id = this._mixer.connect('state-changed', (c, state) => {
                if (state === Gvc.MixerControlState.READY || state === Gvc.MixerControlState.FAILED) {
                    this._mixer.disconnect(id);
                    ready();
                }
            });
        });
    }

    async setVolume(percent) {
        if (percent === null)
            throw new Error(this._('Which volume?'));
        const sink = await this._sink();
        const max = this._mixer.get_vol_max_norm();
        sink.volume = Math.round(max * percent / 100);
        sink.push_volume();
        sink.change_is_muted(percent === 0);
        return percent === 0 ? this._('Sound muted') : this._('Volume %d%%').format(percent);
    }

    async changeVolume(delta) {
        const sink = await this._sink();
        const max = this._mixer.get_vol_max_norm();
        const cur = Math.round(sink.volume / max * 100);
        const next = Math.max(0, Math.min(100, cur + delta));
        sink.volume = Math.round(max * next / 100);
        sink.push_volume();
        if (next > 0 && sink.is_muted)
            sink.change_is_muted(false);
        return this._('Volume %d%%').format(next);
    }

    // -- brightness ---------------------------------------------------------------

    _powerCall(method, args, type) {
        return new Promise((resolve, reject) => {
            Gio.DBus.session.call(POWER_NAME, POWER_PATH, method === 'Set' ? 'org.freedesktop.DBus.Properties' : POWER_IFACE,
                method, args, type ? new GLib.VariantType(type) : null, Gio.DBusCallFlags.NONE, 3000, null,
                (conn, res) => {
                    try {
                        resolve(conn.call_finish(res));
                    } catch (e) {
                        reject(new Error(this._('Brightness is not adjustable on this screen')));
                    }
                });
        });
    }

    async setBrightness(percent) {
        if (percent === null)
            throw new Error(this._('Which brightness?'));
        await this._powerCall('Set', new GLib.Variant('(ssv)', [POWER_IFACE, 'Brightness', GLib.Variant.new_int32(percent)]));
        return this._('Brightness %d%%').format(percent);
    }

    async changeBrightness(delta) {
        const ret = await this._powerCall(delta > 0 ? 'StepUp' : 'StepDown', null, '(ii)');
        const [value] = ret.deepUnpack();
        return this._('Brightness %d%%').format(value);
    }

    // -- settings toggles -----------------------------------------------------------

    darkMode(on) {
        const s = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        s.set_string('color-scheme', on ? 'prefer-dark' : 'default');
        return on ? this._('Dark mode on') : this._('Light mode on');
    }

    doNotDisturb(on) {
        const s = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        s.set_boolean('show-banners', !on);
        return on ? this._('Do not disturb on') : this._('Notifications back on');
    }

    async wifi(on) {
        if (!this._nm) {
            const NM = (await import('gi://NM')).default;
            this._nm = await new Promise((resolve, reject) => {
                NM.Client.new_async(null, (o, res) => {
                    try {
                        resolve(NM.Client.new_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
        }
        this._nm.wireless_enabled = on;
        return on ? this._('Wi‑Fi on') : this._('Wi‑Fi off');
    }

    async bluetooth(on) {
        if (!this._bt) {
            const GnomeBluetooth = (await import('gi://GnomeBluetooth')).default;
            this._bt = new GnomeBluetooth.Client();
        }
        this._bt.default_adapter_powered = on;
        return on ? this._('Bluetooth on') : this._('Bluetooth off');
    }

    // -- workspaces -------------------------------------------------------------------

    workspace(n) {
        const wm = global.workspace_manager;
        let ws;
        if (n === 'next' || n === 'prev') {
            const dir = n === 'next' ? Meta.MotionDirection.RIGHT : Meta.MotionDirection.LEFT;
            ws = wm.get_active_workspace().get_neighbor(dir);
        } else if (n !== null) {
            ws = wm.get_workspace_by_index(n - 1);
        }
        if (!ws)
            throw new Error(this._('No such workspace'));
        ws.activate(global.get_current_time());
        return this._('Workspace %d').format(ws.index() + 1);
    }

    // -- screenshot, lock ---------------------------------------------------------------

    async screenshot(target) {
        if (target === 'area') {
            Main.screenshotUI.open();
            return this._('Select an area');
        }
        const dir = GLib.build_filenamev([GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ?? GLib.get_home_dir(), 'Screenshots']);
        GLib.mkdir_with_parents(dir, 0o755);
        const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d %H-%M-%S');
        const file = Gio.File.new_for_path(GLib.build_filenamev([dir, `Screenshot from ${stamp}.png`]));
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        const shooter = new Shell.Screenshot();
        await new Promise((resolve, reject) => {
            const cb = (o, res) => {
                try {
                    stream.close(null);
                    resolve(target === 'window' ? o.screenshot_window_finish(res) : o.screenshot_finish(res));
                } catch (e) {
                    reject(e);
                }
            };
            if (target === 'window')
                shooter.screenshot_window(true, false, stream, cb);
            else
                shooter.screenshot(false, stream, cb);
        });
        return this._('Saved %s').format(file.get_basename());
    }

    lock() {
        Main.screenShield.lock(true);
        return this._('Locking');
    }

    power(kind) {
        const sa = SystemActions.getDefault();
        const fns = {
            suspend: () => sa.activateSuspend(),
            reboot: () => sa.activateRestart(),
            shutdown: () => sa.activatePowerOff(),
            logout: () => sa.activateLogout(),
        };
        const fn = fns[kind];
        if (!fn)
            throw new Error(this._('Unknown power action'));
        fn();
        return '';
    }
}

// Keep Clutter referenced: Meta.MotionDirection needs the Clutter typelib loaded.
void Clutter;
