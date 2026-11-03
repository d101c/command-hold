import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {engineStatus} from './engine.js';

// Top-bar indicator: icon, enable switch, LLM switch, engine state, preferences.
export const CommandHoldIndicator = GObject.registerClass(
class CommandHoldIndicator extends PanelMenu.Button {
    _init(settings, iconPath, openPreferences, gettext) {
        const _ = gettext || (s => s);
        super._init(0.0, _('Command Hold'));
        this._settings = settings;
        this._openPreferences = openPreferences;

        this.add_child(new St.Icon({gicon: Gio.icon_new_for_string(iconPath), style_class: 'system-status-icon'}));

        this._toggle = new PopupMenu.PopupSwitchMenuItem(_('Enabled'), settings.get_boolean('enabled'));
        this._toggle.connectObject('toggled', (_i, state) => {
            if (settings.get_boolean('enabled') !== state)
                settings.set_boolean('enabled', state);
        }, this);
        this.menu.addMenuItem(this._toggle);

        this._llm = new PopupMenu.PopupSwitchMenuItem(_('Local LLM for open requests'), settings.get_boolean('llm'));
        this._llm.connectObject('toggled', (_i, state) => {
            if (settings.get_boolean('llm') !== state)
                settings.set_boolean('llm', state);
        }, this);
        this.menu.addMenuItem(this._llm);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._status = new PopupMenu.PopupMenuItem(_('Engine: checking…'), {reactive: false});
        this.menu.addMenuItem(this._status);
        this.menu.connectObject('open-state-changed', (_m, open) => {
            if (open)
                this._refresh(_);
        }, this);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefs = new PopupMenu.PopupMenuItem(_('Preferences'));
        prefs.connectObject('activate', () => this._openPreferences(), this);
        this.menu.addMenuItem(prefs);

        settings.connectObject(
            'changed::enabled', () => this._toggle.setToggleState(settings.get_boolean('enabled')),
            'changed::llm', () => this._llm.setToggleState(settings.get_boolean('llm')),
            this);
    }

    // Opening the menu must not spawn the helper: NO_AUTO_START.
    _refresh(_) {
        engineStatus(null, {autoStart: false}).then(st => {
            if (!this._status)
                return;
            if (st === null)
                this._status.label.text = _('Engine: not running (starts on the first command)');
            else if (st.error)
                this._status.label.text = _('Engine: %s').format(st.error);
            else
                this._status.label.text = _('Engine %s — Ollama %s, terminal %s').format(
                    st.version, st.ollama ? (st.model ? _('ready') : _('model missing')) : _('off'), st.terminal || _('none'));
        });
    }

    destroy() {
        this.menu.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._settings = null;
        this._status = null;
        this._toggle = null;
        this._llm = null;
        this._openPreferences = null;
        super.destroy();
    }
});

export function addIndicator(uuid, settings, iconPath, openPreferences, gettext) {
    const indicator = new CommandHoldIndicator(settings, iconPath, openPreferences, gettext);
    Main.panel.addToStatusArea(uuid, indicator);
    return indicator;
}
