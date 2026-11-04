import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// The pill: microphone icon, level bars, and a line of text (status, then the
// words as they come). It never takes focus. Two placements:
//
// - "island": a capsule that is part of the top bar, like the Dynamic Island
//   of a phone. It shares the bar's background, hangs from its bottom edge
//   with rounded lower corners only, swells out of the bar when it opens,
//   grows from both ends as the text grows, and shrinks back into it.
// - "cursor": next to the text cursor (the pointer when there is none), like
//   Voice Hold.
//
// Structure: an outer capsule (fixed size, animated, clipping) around an
// inner content box (natural size, centred).

const BARS = 7;
const BAR_WEIGHTS = [0.45, 0.7, 1.0, 0.8, 1.0, 0.7, 0.45];
const BAR_MIN = 3;
const BAR_MAX = 20;
const HIDE_DELAY_MS = 450;
const MAX_CHARS = 64;

const ISLAND_OVERLAP = 1;    // px the capsule slips under the bar, so no seam shows
const ISLAND_SEED_W = 64;    // width of the bump the capsule swells from
const ISLAND_IN_MS = 380;
const ISLAND_OUT_MS = 240;
const RESIZE_MS = 220;
const CONTENT_FADE_MS = 160;
const PANEL_OPAQUE_ALPHA = 200;   // below this the bar is see-through (Blur my Shell…): use black

export class Hud {
    // getPosition: () => 'island' | 'cursor', read each time the pill opens.
    constructor(iconPath, gettext, getPosition = () => 'island') {
        this._ = gettext || (s => s);
        this._iconPath = iconPath;
        this._getPosition = getPosition;
        this._island = true;
        this._box = null;       // outer capsule
        this._content = null;   // inner box
        this._icon = null;
        this._bars = [];
        this._heights = new Array(BARS).fill(BAR_MIN);
        this._label = null;
        this._hideId = 0;
        this._decayId = 0;
        this._level = 0;
        this._leaving = false;
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
        this._island = this._getPosition() !== 'cursor';

        this._box = new St.Widget({
            style_class: `command-hud ${this._island ? 'command-hud-island' : 'command-hud-cursor'}`,
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: this._island,
            reactive: false,
            opacity: 0,
        });
        if (this._island)
            this._box.set_style(`background-color: ${this._panelColor()};`);

        this._content = new St.BoxLayout({
            style_class: `command-hud-content ${this._island ? 'command-hud-content-island' : ''}`,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._content);

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(this._iconPath),
            style_class: 'command-hud-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._content.add_child(this._icon);

        const bars = new St.BoxLayout({style_class: 'command-hud-bars', y_align: Clutter.ActorAlign.CENTER});
        this._bars = [];
        for (let i = 0; i < BARS; i++) {
            const bar = new St.Widget({style_class: 'command-hud-bar', y_align: Clutter.ActorAlign.CENTER});
            bar.set_height(BAR_MIN);
            bar.add_style_pseudo_class('quiet');
            bars.add_child(bar);
            this._bars.push(bar);
        }
        this._content.add_child(bars);

        this._label = new St.Label({style_class: 'command-hud-text', y_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.set_ellipsize(Pango.EllipsizeMode.START);
        this._label.clutter_text.set_single_line_mode(true);
        this._content.add_child(this._label);

        Main.layoutManager.uiGroup.add_child(this._box);
        // Above everything, but never grabbing anything.
        Main.layoutManager.uiGroup.set_child_above_sibling(this._box, null);
    }

    _destroyBox() {
        if (this._box) {
            this._box.destroy();
            this._box = null;
        }
        this._content = null;
        this._icon = null;
        this._label = null;
        this._bars = [];
        this._heights.fill(BAR_MIN);
        this._level = 0;
        this._leaving = false;
    }

    // The bar's own background, so the capsule reads as a part of it. A
    // see-through bar (transparency extensions) gets plain black, the colour
    // of the bar they are imitating anyway.
    _panelColor() {
        try {
            const c = Main.panel.get_theme_node().get_background_color();
            const [r, g, b, a] = [c.red, c.green, c.blue, c.alpha].map(v => v <= 1 ? Math.round(v * 255) : Math.round(v));
            if (a >= PANEL_OPAQUE_ALPHA)
                return `rgb(${r},${g},${b})`;
        } catch {
            // fall through
        }
        return 'rgb(0,0,0)';
    }

    // -- geometry --------------------------------------------------------

    // Natural size of the capsule: that of its content.
    _natural() {
        const [, w] = this._content.get_preferred_width(-1);
        const [, h] = this._content.get_preferred_height(-1);
        return [Math.ceil(w), Math.ceil(h) + (this._island ? ISLAND_OVERLAP : 0)];
    }

    // Where the capsule hangs from: centred under the primary monitor's bar.
    _islandAnchor(width) {
        const lm = Main.layoutManager;
        const monitor = lm.primaryMonitor;
        const panel = lm.panelBox;
        const bottom = panel ? panel.y + panel.height : (monitor?.y ?? 0);
        const cx = monitor ? monitor.x + monitor.width / 2 : width / 2;
        return [Math.round(cx - width / 2), Math.round(bottom - ISLAND_OVERLAP)];
    }

    _place(animate = false) {
        if (this._island)
            this._placeIsland(animate);
        else
            this._placeAtCursor();
    }

    // Island: ease the capsule to its new natural size, keeping it centred,
    // so a longer text makes it grow from both ends.
    _placeIsland(animate) {
        const [w, h] = this._natural();
        const [x, y] = this._islandAnchor(w);
        for (const prop of ['x', 'width', 'height'])
            this._box.remove_transition(prop);
        this._box.set_y(y);
        if (animate && this._box.opacity > 0 && !this._leaving) {
            this._box.ease({x, width: w, height: h, duration: RESIZE_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        } else {
            this._box.set_position(x, y);
            this._box.set_size(w, h);
        }
    }

    // Cursor: below the text cursor when the application reports it, else
    // the pointer, kept inside its monitor.
    _placeAtCursor() {
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
        const [natWidth, natHeight] = this._natural();
        if (monitor) {
            x = Math.max(monitor.x, Math.min(x, monitor.x + monitor.width - natWidth));
            if (y + natHeight > monitor.y + monitor.height)
                y = (rect ? rect.y : y) - natHeight - 8;
            y = Math.max(monitor.y, y);
        }
        this._box.set_position(Math.round(x), Math.round(y));
    }

    // -- entrance / exit -------------------------------------------------

    // Island: a small bump swells out of the bar into the full capsule, the
    // content fading in once there is room for it. Cursor: a plain fade.
    _enter() {
        this._leaving = false;
        this._box.remove_all_transitions();
        this._content.remove_all_transitions();
        if (!this._island) {
            this._box.opacity = 255;
            this._content.opacity = 255;
            return;
        }
        const [w, h] = this._natural();
        const [x, y] = this._islandAnchor(w);
        const seedW = Math.min(ISLAND_SEED_W, w);
        this._box.set_position(Math.round(x + (w - seedW) / 2), y);
        this._box.set_size(seedW, 0);
        this._box.opacity = 255;
        this._content.opacity = 0;
        this._box.ease({
            x, width: w, height: h,
            duration: ISLAND_IN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
        this._content.ease({
            opacity: 255,
            duration: CONTENT_FADE_MS,
            delay: ISLAND_IN_MS - CONTENT_FADE_MS - 60,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // ... and back into the bar.
    _leave(onComplete) {
        this._leaving = true;
        this._box.remove_all_transitions();
        this._content.remove_all_transitions();
        if (!this._island) {
            this._box.ease({opacity: 0, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete});
            return;
        }
        const w = this._box.width;
        const seedW = Math.min(ISLAND_SEED_W, w);
        this._content.ease({opacity: 0, duration: CONTENT_FADE_MS * 0.6, mode: Clutter.AnimationMode.EASE_IN_QUAD});
        this._box.ease({
            x: Math.round(this._box.x + (w - seedW) / 2),
            width: seedW,
            height: 0,
            duration: ISLAND_OUT_MS,
            delay: 40,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete,
        });
    }

    // -- public ----------------------------------------------------------

    show(status, pseudo = '') {
        this._cancelHide();
        this._build();
        const fresh = this._box.opacity === 0;
        const leaving = this._leaving;
        this._setIconState(pseudo);
        this._setText(status, 'hint');
        if (fresh || leaving) {
            // New, or caught on its way out: (re)open from the bar.
            if (!this._island)
                this._place();
            this._enter();
        } else {
            this._place(true);
        }
    }

    status(text, pseudo = '') {
        if (!this._box)
            return;
        this._setIconState(pseudo);
        this._setText(text, 'hint');
        this._place(true);
    }

    live(text) {
        if (!this._box)
            return;
        const chars = Array.from(text.replace(/\n/g, ' ⏎ '));
        const shown = chars.length > MAX_CHARS ? '…' + chars.slice(-MAX_CHARS).join('') : chars.join('');
        this._setText(shown, 'live');
        this._place(true);
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
            if (this._box)
                this._leave(() => this._destroyBox());
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
