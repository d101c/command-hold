import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Commander} from './commander.js';
import {addIndicator} from './panelIndicator.js';

// Hold the shortcut (<Super>c by default), say what to do, release:
// GNOME actions run at once, shell commands after a confirmation.
export default class CommandHoldExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._bound = false;
        this._commander = new Commander(this._settings, `${this.path}/icons/command-hold-symbolic.svg`, _);
        this._commander.warmUp();
        this._bind();

        this._indicator = null;
        if (this._settings.get_boolean('show-indicator'))
            this._addIndicator();

        const rebind = () => {
            this._unbind();
            this._bind();
        };
        const toggleIndicator = () => {
            if (this._settings.get_boolean('show-indicator'))
                this._addIndicator();
            else
                this._removeIndicator();
        };
        this._settings.connectObject(
            'changed::enabled', rebind,
            'changed::command-shortcut', rebind,
            'changed::show-indicator', toggleIndicator,
            this);
    }

    disable() {
        this._unbind();
        this._removeIndicator();
        this._settings.disconnectObject(this);
        if (this._commander) {
            this._commander.destroy();
            this._commander = null;
        }
        this._settings = null;
    }

    _addIndicator() {
        if (this._indicator)
            return;
        this._indicator = addIndicator(this.uuid, this._settings,
            `${this.path}/icons/command-hold-symbolic.svg`, () => this.openPreferences(), _);
    }

    _removeIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _bind() {
        if (this._bound || !this._settings.get_boolean('enabled'))
            return;
        // IGNORE_AUTOREPEAT: holding Super+C must fire once, not every 30 ms.
        Main.wm.addKeybinding('command-shortcut', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL,
            () => this._commander?.shortcut());
        this._bound = true;
    }

    _unbind() {
        if (!this._bound)
            return;
        Main.wm.removeKeybinding('command-shortcut');
        this._bound = false;
    }
}
