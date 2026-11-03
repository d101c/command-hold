import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {engineStatus} from './engine.js';

const VOICE = {name: 'org.griffit.VoiceHold', path: '/org/griffit/VoiceHold', iface: 'org.griffit.VoiceHold'};
const INSTALL_ENGINE = 'pipx install "git+https://github.com/d101c/command-hold#subdirectory=engine" && command-hold-engine install-service';
const INSTALL_VOICE = 'pipx install "git+https://github.com/d101c/voice-hold#subdirectory=engine" && voice-hold-engine setup';
const INSTALL_OLLAMA = 'curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen3:1.7b';

export default class CommandHoldPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: _('Command Hold'), icon_name: 'utilities-terminal-symbolic'});
        window.add(page);
        this._buildEngineGroup(page, window, settings);
        this._buildGestureGroup(page, settings);
        this._buildLlmGroup(page, settings);
        this._buildAppearanceGroup(page, settings);
    }

    // -- helpers -------------------------------------------------------------

    _commandRow(group, window, title, cmd) {
        const row = new Adw.ActionRow({title});
        const copy = new Gtk.Button({icon_name: 'edit-copy-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Copy')});
        copy.add_css_class('flat');
        copy.connect('clicked', () => {
            Gdk.Display.get_default().get_clipboard().set(cmd);
            window.add_toast(new Adw.Toast({title: _('Copied'), timeout: 2}));
        });
        row.add_suffix(copy);
        group.add(row);
        const label = new Gtk.Label({label: cmd, selectable: true, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR,
            xalign: 0, margin_top: 4, margin_bottom: 8, margin_start: 12, margin_end: 12});
        label.add_css_class('monospace');
        label.add_css_class('dim-label');
        group.add(label);
    }

    _statusRow(group, title, check) {
        const row = new Adw.ActionRow({title, subtitle: _('Checking…')});
        const refresh = new Gtk.Button({icon_name: 'view-refresh-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Check again')});
        refresh.add_css_class('flat');
        row.add_suffix(refresh);
        group.add(row);
        const run = () => {
            row.set_subtitle(_('Checking…'));
            check().then(s => row.set_subtitle(s));
        };
        refresh.connect('clicked', run);
        run();
    }

    // -- engines -----------------------------------------------------------------

    _buildEngineGroup(page, window, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Engines'),
            description: _('Everything runs on this computer: Voice Hold listens, command-hold-engine understands and runs confirmed commands, Ollama (optional) handles open requests.'),
        });
        page.add(group);

        this._statusRow(group, _('Command engine'), () => engineStatus().then(st => {
            if (!st || st.error === 'not-installed')
                return _('Not installed — run the first command below, then check again');
            if (st.error)
                return _('Installed but failed to start: %s').format(st.message ?? st.error);
            const parts = [_('Ready — engine %s').format(st.version)];
            parts.push(st.terminal ? _('terminal: %s').format(st.terminal) : _('no terminal found (install Ptyxis)'));
            parts.push(st.ollama ? (st.model ? _('Ollama ready (%s)').format(st.model_name) : _('Ollama up, model %s missing').format(st.model_name)) : _('Ollama not running'));
            return parts.join(' · ');
        }));
        this._statusRow(group, _('Voice Hold engine'), () => this._voiceStatus());
        this._commandRow(group, window, _('Install the command engine'), INSTALL_ENGINE);
        this._commandRow(group, window, _('Install the Voice Hold engine'), INSTALL_VOICE);
        this._commandRow(group, window, _('Install Ollama and the model (optional)'), INSTALL_OLLAMA);
    }

    _voiceStatus() {
        return new Promise(resolve => {
            try {
                Gio.DBus.session.call(VOICE.name, VOICE.path, VOICE.iface, 'Status', null,
                    new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, 15000, null, (conn, res) => {
                        try {
                            const [dict] = conn.call_finish(res).deepUnpack();
                            const get = k => dict[k]?.deepUnpack();
                            resolve(get('models_ready') ? _('Ready — engine %s, models installed').format(get('version'))
                                : _('Engine %s found, models missing — run: voice-hold-engine setup').format(get('version')));
                        } catch (e) {
                            const name = Gio.DBusError.is_remote_error(e) ? Gio.DBusError.get_remote_error(e) : '';
                            resolve(name === 'org.freedesktop.DBus.Error.ServiceUnknown'
                                ? _('Not installed — run the second command below, then check again') : e.message);
                        }
                    });
            } catch (e) {
                resolve(e.message);
            }
        });
    }

    // -- gesture -------------------------------------------------------------------

    _buildGestureGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Gesture'),
            description: _('Hold the shortcut and say what to do; release to run. A quick tap keeps listening hands-free.'),
        });
        page.add(group);
        const enabled = new Adw.SwitchRow({title: _('Enabled')});
        group.add(enabled);
        settings.bind('enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(this._shortcutRow(settings));
        const modes = ['auto', 'hold', 'toggle'];
        const modeRow = new Adw.ComboRow({
            title: _('Mode'),
            subtitle: _('Auto: hold or tap. Hold: release always stops. Toggle: the shortcut starts and stops.'),
            model: Gtk.StringList.new([_('Hold or tap'), _('Hold only'), _('Toggle only')]),
        });
        modeRow.set_selected(Math.max(0, modes.indexOf(settings.get_string('mode'))));
        modeRow.connect('notify::selected', () => settings.set_string('mode', modes[modeRow.get_selected()]));
        group.add(modeRow);
        const tap = new Adw.SpinRow({title: _('Tap threshold (ms)'), adjustment: new Gtk.Adjustment({lower: 150, upper: 1000, step_increment: 50})});
        group.add(tap);
        settings.bind('tap-ms', tap, 'value', Gio.SettingsBindFlags.DEFAULT);
        const silence = new Adw.SpinRow({title: _('Stop after silence (s)'), subtitle: _('Hands-free mode only. 0 = never.'), digits: 1,
            adjustment: new Gtk.Adjustment({lower: 0, upper: 60, step_increment: 0.5})});
        group.add(silence);
        settings.bind('silence-stop-s', silence, 'value', Gio.SettingsBindFlags.DEFAULT);
    }

    _shortcutRow(settings) {
        const row = new Adw.ActionRow({title: _('Shortcut'), activatable: true});
        const label = new Gtk.ShortcutLabel({disabled_text: _('Not set'), accelerator: settings.get_strv('command-shortcut')[0] ?? '', valign: Gtk.Align.CENTER});
        row.add_suffix(label);
        settings.connect('changed::command-shortcut', () => label.set_accelerator(settings.get_strv('command-shortcut')[0] ?? ''));
        row.connect('activated', () => {
            const dialog = new Adw.Window({modal: true, transient_for: row.get_root(), title: _('Set shortcut'), default_width: 360, default_height: 160, resizable: false});
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 24, margin_bottom: 24, margin_start: 24, margin_end: 24, valign: Gtk.Align.CENTER});
            box.append(new Gtk.Label({label: _('Press the new shortcut, with a modifier (Super, Ctrl, Alt).\nEscape cancels, Backspace clears.'), justify: Gtk.Justification.CENTER, wrap: true}));
            box.append(new Gtk.ShortcutLabel({accelerator: settings.get_strv('command-shortcut')[0] ?? '', halign: Gtk.Align.CENTER}));
            dialog.set_content(box);
            const ctl = new Gtk.EventControllerKey();
            ctl.connect('key-pressed', (_c, keyval, _code, state) => {
                const mask = state & Gtk.accelerator_get_default_mod_mask();
                if (keyval === Gdk.KEY_Escape) {
                    dialog.close();
                    return Gdk.EVENT_STOP;
                }
                if (keyval === Gdk.KEY_BackSpace) {
                    settings.set_strv('command-shortcut', []);
                    dialog.close();
                    return Gdk.EVENT_STOP;
                }
                const real = mask & ~(Gdk.ModifierType.SHIFT_MASK | Gdk.ModifierType.LOCK_MASK);
                if (!real || !Gtk.accelerator_valid(keyval, mask))
                    return Gdk.EVENT_STOP;
                settings.set_strv('command-shortcut', [Gtk.accelerator_name(keyval, mask)]);
                dialog.close();
                return Gdk.EVENT_STOP;
            });
            dialog.add_controller(ctl);
            dialog.present();
        });
        return row;
    }

    // -- LLM --------------------------------------------------------------------

    _buildLlmGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Open requests'),
            description: _('GNOME actions are recognised by rules, instantly. Anything else (shell commands, questions) goes to a small local LLM through Ollama. Every command is shown and confirmed before it runs, in a visible terminal.'),
        });
        page.add(group);
        const sw = new Adw.SwitchRow({title: _('Use the local LLM')});
        group.add(sw);
        settings.bind('llm', sw, 'active', Gio.SettingsBindFlags.DEFAULT);
        const model = new Adw.EntryRow({title: _('Model')});
        group.add(model);
        settings.bind('llm-model', model, 'text', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('llm', model, 'sensitive', Gio.SettingsBindFlags.GET);
        const url = new Adw.EntryRow({title: _('Ollama URL')});
        group.add(url);
        settings.bind('llm-url', url, 'text', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('llm', url, 'sensitive', Gio.SettingsBindFlags.GET);
        const dir = new Adw.EntryRow({title: _('Working folder for commands (empty = home)')});
        group.add(dir);
        settings.bind('work-dir', dir, 'text', Gio.SettingsBindFlags.DEFAULT);
    }

    // -- appearance -------------------------------------------------------------

    _buildAppearanceGroup(page, settings) {
        const group = new Adw.PreferencesGroup({title: _('Appearance')});
        page.add(group);
        const hud = new Adw.SwitchRow({title: _('Show the pill'), subtitle: _('Microphone level, words heard and the result, next to the cursor.')});
        group.add(hud);
        settings.bind('show-hud', hud, 'active', Gio.SettingsBindFlags.DEFAULT);
        const ind = new Adw.SwitchRow({title: _('Top-bar indicator')});
        group.add(ind);
        settings.bind('show-indicator', ind, 'active', Gio.SettingsBindFlags.DEFAULT);
    }
}
