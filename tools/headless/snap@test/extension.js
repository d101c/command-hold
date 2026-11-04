// Frame grabber for the headless bench: once $SNAP_DIR/go exists, screenshots
// the top band of the screen (where the island hangs) every ~40 ms into
// $SNAP_DIR/fNNNNNN.png until $SNAP_DIR/stop.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
export default class Snap {
    enable() {
        this._dir = GLib.getenv('SNAP_DIR');
        this._busy = false;
        this._t0 = 0;
        this._rect = [240, 0, 800, 420];
        this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => this._tick());
    }
    _tick() {
        const go = GLib.file_test(`${this._dir}/go`, GLib.FileTest.EXISTS);
        const stop = GLib.file_test(`${this._dir}/stop`, GLib.FileTest.EXISTS);
        if (!go || stop || this._busy)
            return GLib.SOURCE_CONTINUE;
        if (!this._t0)
            this._t0 = GLib.get_monotonic_time();
        this._busy = true;
        const ms = Math.round((GLib.get_monotonic_time() - this._t0) / 1000);
        const file = Gio.File.new_for_path(`${this._dir}/f${String(ms).padStart(6, '0')}.png`);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        const shot = new Shell.Screenshot();
        shot.screenshot_area(...this._rect, stream, (o, res) => {
            try { o.screenshot_area_finish(res); } catch (e) { logError(e, 'snap'); }
            stream.close(null);
            this._busy = false;
        });
        return GLib.SOURCE_CONTINUE;
    }
    disable() { GLib.source_remove(this._id); }
}
