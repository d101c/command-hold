import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// The dark pill next to the text cursor: microphone icon, level bars, and a
// line of text (status, then the words as they come). It never takes focus.

const BARS = 7;
const BAR_WEIGHTS = [0.45, 0.7, 1.0, 0.8, 1.0, 0.7, 0.45];
const BAR_MIN = 3;
const BAR_MAX = 20;
const HIDE_DELAY_MS = 450;
const MAX_CHARS = 64;

export class Hud {
    constructor(iconPath, gettext) {
        this._ = gettext || (s => s);
        this._iconPath = iconPath;
        this._box = null;
        this._icon = null;
        this._bars = [];
        this._heights = new Array(BARS).fill(BAR_MIN);
        this._label = null;
        this._hideId = 0;
        this._decayId = 0;
        this._level = 0;
    }

    destroy() {
        this._cancelHide();
        this._stopDecay();
        this._destroyBox();
    }

    // -- building --------------------------------------------------------

    _build() {
        if (this._box)
            return;
        this._box = new St.BoxLayout({style_class: 'command-hud', reactive: false, y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(this._iconPath),
            style_class: 'command-hud-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._icon);

        const bars = new St.BoxLayout({style_class: 'command-hud-bars', y_align: Clutter.ActorAlign.CENTER});
        this._bars = [];
        for (let i = 0; i < BARS; i++) {
            const bar = new St.Widget({style_class: 'command-hud-bar', y_align: Clutter.ActorAlign.CENTER});
            bar.set_height(BAR_MIN);
            bar.add_style_pseudo_class('quiet');
            bars.add_child(bar);
            this._bars.push(bar);
        }
        this._box.add_child(bars);

        this._label = new St.Label({style_class: 'command-hud-text', y_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.set_ellipsize(Pango.EllipsizeMode.START);
        this._label.clutter_text.set_single_line_mode(true);
        this._box.add_child(this._label);

        Main.layoutManager.uiGroup.add_child(this._box);
        // Above everything, but never grabbing anything.
        Main.layoutManager.uiGroup.set_child_above_sibling(this._box, null);
    }

    _destroyBox() {
        if (this._box) {
            this._box.destroy();
            this._box = null;
        }
        this._icon = null;
        this._label = null;
        this._bars = [];
        this._heights.fill(BAR_MIN);
        this._level = 0;
    }

    // Below the text cursor when the application reports it, else the pointer.
    _place() {
        const rect = Main.inputMethod?._cursorRect;
        let x, y;
        if (rect && (rect.x || rect.y)) {
            [x, y] = [rect.x, rect.y + rect.height + 8];
        } else {
            const [px, py] = global.get_pointer();
            [x, y] = [px, py + 24];
        }
        // findMonitorForPoint() only exists from GNOME 46: look the monitor
        // up by hand, and fall back to the primary one.
        const lm = Main.layoutManager;
        const monitor = (lm.monitors ?? []).find(m =>
            x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) ??
            lm.primaryMonitor;
        const [, natWidth] = this._box.get_preferred_width(-1);
        const [, natHeight] = this._box.get_preferred_height(-1);
        if (monitor) {
            x = Math.max(monitor.x, Math.min(x, monitor.x + monitor.width - natWidth));
            if (y + natHeight > monitor.y + monitor.height)
                y = (rect ? rect.y : y) - natHeight - 8;
            y = Math.max(monitor.y, y);
        }
        this._box.set_position(Math.round(x), Math.round(y));
    }

    // -- public ----------------------------------------------------------

    show(status, pseudo = '') {
        this._cancelHide();
        this._build();
        // A fade-out may still be running from the previous hide(): its
        // onComplete would destroy the box we are about to use.
        this._box.remove_all_transitions();
        this._setIconState(pseudo);
        this._setText(status, 'hint');
        this._place();
        this._box.opacity = 255;
    }

    status(text, pseudo = '') {
        if (!this._box)
            return;
        this._setIconState(pseudo);
        this._setText(text, 'hint');
        this._place();
    }

    live(text) {
        if (!this._box)
            return;
        const chars = Array.from(text.replace(/\n/g, ' ⏎ '));
        const shown = chars.length > MAX_CHARS ? '…' + chars.slice(-MAX_CHARS).join('') : chars.join('');
        this._setText(shown, 'live');
        this._place();
    }

    error(text) {
        this.show(text, 'error');
        this.hide(4000);
    }

    level(v) {
        if (!this._box)
            return;
        this._level = Math.max(0, Math.min(1, v));
        this._paintBars();
        this._startDecay();
    }

    hide(delay = HIDE_DELAY_MS) {
        this._cancelHide();
        if (!this._box)
            return;
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._hideId = 0;
            this._stopDecay();
            if (this._box) {
                this._box.ease({
                    opacity: 0,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => this._destroyBox(),
                });
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    hideNow() {
        this._cancelHide();
        this._stopDecay();
        this._destroyBox();
    }

    // -- internals -------------------------------------------------------

    _setIconState(pseudo) {
        if (!this._icon)
            return;
        for (const p of ['listening', 'loading', 'error'])
            this._icon.remove_style_pseudo_class(p);
        if (pseudo)
            this._icon.add_style_pseudo_class(pseudo);
        // Grey and breathing until the engine says it listens; then solid blue.
        this._icon.remove_all_transitions();
        this._icon.opacity = 255;
        if (pseudo === 'loading')
            this._breathe();
    }

    _breathe() {
        if (!this._icon || !this._icon.has_style_pseudo_class('loading'))
            return;
        const dim = this._icon.opacity > 150;
        this._icon.ease({
            opacity: dim ? 90 : 255,
            duration: 600,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            onComplete: () => this._breathe(),
        });
    }

    _setText(text, pseudo) {
        if (!this._label)
            return;
        for (const p of ['live', 'hint'])
            this._label.remove_style_pseudo_class(p);
        this._label.add_style_pseudo_class(pseudo);
        this._label.set_text(text);
    }

    _paintBars() {
        for (let i = 0; i < this._bars.length; i++) {
            const target = BAR_MIN + (BAR_MAX - BAR_MIN) * this._level * BAR_WEIGHTS[i] *
                (0.85 + 0.3 * Math.random());
            // Fast attack, slow release.
            const cur = this._heights[i];
            this._heights[i] = target > cur ? target : cur + (target - cur) * 0.35;
            this._bars[i].set_height(Math.round(this._heights[i]));
            if (this._heights[i] > BAR_MIN + 1.5)
                this._bars[i].remove_style_pseudo_class('quiet');
            else
                this._bars[i].add_style_pseudo_class('quiet');
        }
    }

    _startDecay() {
        if (this._decayId)
            return;
        this._decayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            if (!this._box) {
                this._decayId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._level *= 0.75;
            this._paintBars();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopDecay() {
        if (this._decayId) {
            GLib.source_remove(this._decayId);
            this._decayId = 0;
        }
    }

    _cancelHide() {
        if (this._hideId) {
            GLib.source_remove(this._hideId);
            this._hideId = 0;
        }
    }
}
