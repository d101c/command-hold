import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

// The setup assistant's logic, shared by the Hold extensions (copied into
// each one; the source of truth is github.com/d101c/hold-setup).
//
// Everything happens in the preferences process, with GNOME libraries and
// no subprocess: files are downloaded with libsoup, checked against the
// SHA-256 of the manifest, unpacked with libgnome-autoar, and a D-Bus
// service file is written so the engines run with the system Python.
//
// Layout (XDG data dir, ~/.local/share by default):
//   hold/pylib/            unpacked Python wheels, shared by the engines
//   hold/downloads/        archives while they are being fetched
//   hold/ollama/           the Ollama bundle (optional)
//   voice-hold/models/     speech models (where voice-hold-engine looks)
//   dbus-1/services/       org.griffit.VoiceHold.service, org.griffit.CommandHold.service

export const MANIFEST_URL = 'https://raw.githubusercontent.com/d101c/hold-setup/master/manifest.json';
const CHUNK = 256 * 1024;

export function dataDir() {
    return GLib.get_user_data_dir();
}

export function paths(base = dataDir()) {
    return {
        base,
        hold: GLib.build_filenamev([base, 'hold']),
        pylib: GLib.build_filenamev([base, 'hold', 'pylib']),
        downloads: GLib.build_filenamev([base, 'hold', 'downloads']),
        ollama: GLib.build_filenamev([base, 'hold', 'ollama']),
        models: GLib.build_filenamev([base, 'voice-hold', 'models']),
        services: GLib.build_filenamev([base, 'dbus-1', 'services']),
    };
}

// -- system Python ---------------------------------------------------------------

// {exe, version: '3.14', tag: 'cp314'} from the python3 symlink, or null.
export function systemPython(exe = '/usr/bin/python3') {
    const f = Gio.File.new_for_path(exe);
    let target = null;
    try {
        const info = f.query_info('standard::symlink-target,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        target = info.get_symlink_target() ?? exe;
    } catch {
        return null;
    }
    const m = /python(\d+)\.(\d+)/.exec(target ?? '');
    if (!m)
        return null;
    return {exe, version: `${m[1]}.${m[2]}`, tag: `cp${m[1]}${m[2]}`};
}

export function versionAtLeast(version, min) {
    const [a, b] = version.split('.').map(Number);
    const [c, d] = min.split('.').map(Number);
    return a > c || (a === c && b >= d);
}

// -- state -------------------------------------------------------------------------

function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

function serviceState(p, busName, module) {
    const file = GLib.build_filenamev([p.services, `${busName}.service`]);
    if (!exists(file))
        return 'missing';
    try {
        const [, bytes] = GLib.file_get_contents(file);
        const text = new TextDecoder().decode(bytes);
        if (text.includes(p.pylib) && exists(GLib.build_filenamev([p.pylib, module])))
            return 'assistant';
        return 'external';     // pipx, a venv: not ours, but there
    } catch {
        return 'missing';
    }
}

function modelsPresent(p, manifest) {
    for (const m of manifest?.voice?.models ?? []) {
        if (m.extract) {
            if (!exists(GLib.build_filenamev([p.models, m.dir])))
                return false;
        } else {
            const f = GLib.build_filenamev([p.models, m.name]);
            if (!exists(f))
                return false;
            try {
                const size = Gio.File.new_for_path(f).query_info('standard::size', 0, null).get_size();
                if (size !== m.size)
                    return false;
            } catch {
                return false;
            }
        }
    }
    return true;
}

// Synchronous, cheap: what is installed where.
export function detect(manifest, base = dataDir()) {
    const p = paths(base);
    const voice = serviceState(p, manifest?.voice?.bus_name ?? 'org.griffit.VoiceHold', manifest?.voice?.module ?? 'voice_hold_engine');
    const command = serviceState(p, manifest?.command?.bus_name ?? 'org.griffit.CommandHold', manifest?.command?.module ?? 'command_hold_engine');
    return {
        python: systemPython(),
        voice: {service: voice, models: manifest ? modelsPresent(p, manifest) : null},
        command: {service: command},
        ollama: {bundled: exists(GLib.build_filenamev([p.ollama, 'bin', 'ollama']))},
    };
}

// -- HTTP ------------------------------------------------------------------------------

let session = null;
function soup() {
    if (!session)
        session = new Soup.Session({user_agent: 'hold-setup/1', timeout: 60});
    return session;
}

function readAll(stream, cancellable) {
    return new Promise((resolve, reject) => {
        const out = Gio.MemoryOutputStream.new_resizable();
        out.splice_async(stream, Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
            GLib.PRIORITY_DEFAULT, cancellable, (o, res) => {
                try {
                    o.splice_finish(res);
                    resolve(o.steal_as_bytes());
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export function httpGet(url, cancellable = null) {
    return new Promise((resolve, reject) => {
        const msg = Soup.Message.new('GET', url);
        soup().send_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            try {
                const stream = s.send_finish(res);
                if (msg.get_status() !== Soup.Status.OK)
                    throw new Error(`HTTP ${msg.get_status()} for ${url}`);
                resolve({stream, length: msg.get_response_headers().get_content_length()});
            } catch (e) {
                reject(e);
            }
        });
    });
}

export async function httpJson(url, cancellable = null) {
    const {stream} = await httpGet(url, cancellable);
    const bytes = await readAll(stream, cancellable);
    return JSON.parse(new TextDecoder().decode(bytes.toArray()));
}

export function fetchManifest(cancellable = null, url = MANIFEST_URL) {
    return httpJson(url, cancellable);
}

// Download `url` to `dest`, hashing on the way; progress(done, total).
// Resolves to the hex SHA-256. file:// URLs are read with Gio (tests).
export async function download(url, dest, progress, cancellable = null, expectedSize = 0) {
    let stream, total;
    if (url.startsWith('file://')) {
        const f = Gio.File.new_for_uri(url);
        stream = f.read(cancellable);
        total = f.query_info('standard::size', 0, cancellable).get_size();
    } else {
        ({stream, length: total} = await httpGet(url, cancellable));
    }
    if (!total || total < 0)
        total = expectedSize;
    const out = Gio.File.new_for_path(dest).replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
    const sum = new GLib.Checksum(GLib.ChecksumType.SHA256);
    let done = 0;
    try {
        for (;;) {
            const bytes = await new Promise((resolve, reject) => {
                stream.read_bytes_async(CHUNK, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
                    try {
                        resolve(s.read_bytes_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            if (bytes.get_size() === 0)
                break;
            sum.update(bytes.toArray());
            out.write_bytes(bytes, cancellable);
            done += bytes.get_size();
            progress?.(done, total);
        }
    } finally {
        out.close(null);
        stream.close(null);
    }
    return sum.get_string();
}

// -- archives ------------------------------------------------------------------------------

// Unpack `archive` into `dir` (zip, tar.*, …) with libgnome-autoar.
export function extract(archive, dir, progress, cancellable = null) {
    return new Promise((resolve, reject) => {
        import('gi://GnomeAutoar?version=0.1').then(({default: Autoar}) => {
            GLib.mkdir_with_parents(dir, 0o755);
            const ex = new Autoar.Extractor({
                source_file: Gio.File.new_for_path(archive),
                output_file: Gio.File.new_for_path(dir),
                output_is_dest: true,
                delete_after_extraction: false,
            });
            let total = 0;
            ex.connect('scanned', (_e, n) => {
                total = n;
            });
            ex.connect('progress', (_e, _size, files) => progress?.(files, total));
            ex.connect('conflict', (_e, _file, _new) => 2 /* AUTOAR_CONFLICT_OVERWRITE */);
            ex.connect('error', (_e, err) => reject(new Error(err.message)));
            ex.connect('cancelled', () => reject(new Error('cancelled')));
            ex.connect('completed', () => resolve());
            ex.start_async(cancellable);
        }).catch(reject);
    });
}

// -- services ---------------------------------------------------------------------------------

export function serviceText(busName, module, python, p, env = {}) {
    const vars = Object.entries({PYTHONPATH: p.pylib, ...env}).map(([k, v]) => `${k}=${v}`).join(' ');
    return `[D-BUS Service]\nName=${busName}\nExec=/usr/bin/env ${vars} ${python.exe} -m ${module} serve\n`;
}

export function writeService(busName, module, python, p, env = {}) {
    GLib.mkdir_with_parents(p.services, 0o755);
    const file = GLib.build_filenamev([p.services, `${busName}.service`]);
    GLib.file_set_contents(file, serviceText(busName, module, python, p, env));
    return file;
}

// -- installation --------------------------------------------------------------------------------

// progress({step, label, fraction}) is called often; `fraction` is for the
// whole component. Steps: download, verify, extract, service.
export class Installer {
    constructor(manifest, {base = dataDir(), progress = null} = {}) {
        this.manifest = manifest;
        this.p = paths(base);
        this.progress = progress ?? (() => {});
        this.python = systemPython();
        this.cancellable = new Gio.Cancellable();
        for (const d of [this.p.pylib, this.p.downloads, this.p.models, this.p.services])
            GLib.mkdir_with_parents(d, 0o755);
    }

    cancel() {
        this.cancellable.cancel();
    }

    _needPython() {
        const min = this.manifest.python?.min ?? '3.12';
        if (!this.python)
            throw new Error('python3-missing');
        if (!versionAtLeast(this.python.version, min))
            throw new Error(`python3-too-old:${this.python.version}`);
        if (!this.manifest.wheels?.[this.python.tag])
            throw new Error(`python3-unsupported:${this.python.version}`);
    }

    // Fetch every item of `items` into downloads/ (reusing a good copy),
    // verifying size and SHA-256. Returns the local paths.
    async _fetchAll(items, weight) {
        const total = items.reduce((s, i) => s + i.size, 0);
        let before = 0;
        const out = [];
        for (const item of items) {
            const dest = GLib.build_filenamev([this.p.downloads, item.name]);
            let ok = false;
            if (GLib.file_test(dest, GLib.FileTest.EXISTS)) {
                this.progress({step: 'verify', label: item.name, fraction: weight.start + weight.span * before / total});
                ok = await this._checksum(dest) === item.sha256;
            }
            if (!ok) {
                const sha = await download(item.url, dest, (done, _t) => {
                    this.progress({step: 'download', label: item.name, done, total: item.size,
                        fraction: weight.start + weight.span * (before + Math.min(done, item.size)) / total});
                }, this.cancellable, item.size);
                if (sha !== item.sha256)
                    throw new Error(`checksum-mismatch:${item.name}`);
            }
            before += item.size;
            out.push(dest);
        }
        return out;
    }

    _checksum(path) {
        return new Promise((resolve, reject) => {
            const f = Gio.File.new_for_path(path);
            f.load_bytes_async(this.cancellable, (file, res) => {
                try {
                    const [bytes] = file.load_bytes_finish(res);
                    resolve(GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async _unpackWheels(files, weight) {
        for (let i = 0; i < files.length; i++) {
            const name = GLib.path_get_basename(files[i]);
            this.progress({step: 'extract', label: name, fraction: weight.start + weight.span * i / files.length});
            await extract(files[i], this.p.pylib, null, this.cancellable);
            GLib.unlink(files[i]);
        }
    }

    async installVoice() {
        this._needPython();
        const m = this.manifest;
        const wheels = m.wheels[this.python.tag].voice;
        const files = await this._fetchAll(wheels, {start: 0, span: 0.08});
        await this._unpackWheels(files, {start: 0.08, span: 0.04});
        const models = m.voice.models;
        const archives = await this._fetchAll(models, {start: 0.12, span: 0.78});
        for (let i = 0; i < models.length; i++) {
            const item = models[i];
            if (item.extract) {
                // bzip2 is slow (about 90 s for the speech model): keep the bar moving.
                const start = 0.9 + 0.08 * i / models.length;
                this.progress({step: 'extract', label: item.name, fraction: start});
                await extract(archives[i], this.p.models, (files, total) => {
                    this.progress({step: 'extract', label: item.name, fraction: start + 0.08 / models.length * (total ? files / total : 0)});
                }, this.cancellable);
                GLib.unlink(archives[i]);
            } else {
                const dest = Gio.File.new_for_path(GLib.build_filenamev([this.p.models, item.name]));
                Gio.File.new_for_path(archives[i]).move(dest, Gio.FileCopyFlags.OVERWRITE, this.cancellable, null);
            }
        }
        this.progress({step: 'service', label: m.voice.bus_name, fraction: 0.99});
        writeService(m.voice.bus_name, m.voice.module, this.python, this.p, {VOICE_HOLD_MODELS: this.p.models});
        this.progress({step: 'done', label: '', fraction: 1});
    }

    async installCommand() {
        this._needPython();
        const m = this.manifest;
        const files = await this._fetchAll(m.wheels[this.python.tag].command, {start: 0, span: 0.7});
        await this._unpackWheels(files, {start: 0.7, span: 0.25});
        this.progress({step: 'service', label: m.command.bus_name, fraction: 0.98});
        writeService(m.command.bus_name, m.command.module, this.python, this.p);
        this.progress({step: 'done', label: '', fraction: 1});
    }

    // The Ollama bundle, unpacked into hold/ollama (bin/ollama, lib/ollama).
    async installOllama() {
        const item = this.manifest.llm.ollama;
        const [file] = await this._fetchAll([item], {start: 0, span: 0.85});
        this.progress({step: 'extract', label: item.name, fraction: 0.86});
        await extract(file, this.p.ollama, null, this.cancellable);
        GLib.unlink(file);
        this.progress({step: 'done', label: '', fraction: 1});
    }

    // Pull the model through a running Ollama (system or bundled, started by
    // the command engine). Streams /api/pull for progress.
    async pullModel(url = 'http://127.0.0.1:11434') {
        const model = this.manifest.llm.model;
        const msg = Soup.Message.new('POST', `${url}/api/pull`);
        msg.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode(JSON.stringify({model, stream: true}))));
        const stream = await new Promise((resolve, reject) => {
            soup().send_async(msg, GLib.PRIORITY_DEFAULT, this.cancellable, (s, res) => {
                try {
                    resolve(s.send_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
        const dis = new Gio.DataInputStream({base_stream: stream});
        for (;;) {
            const line = await new Promise((resolve, reject) => {
                dis.read_line_async(GLib.PRIORITY_DEFAULT, this.cancellable, (d, res) => {
                    try {
                        const [l] = d.read_line_finish_utf8(res);
                        resolve(l);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            if (line === null)
                break;
            let ev;
            try {
                ev = JSON.parse(line);
            } catch {
                continue;
            }
            if (ev.error)
                throw new Error(ev.error);
            if (ev.total)
                this.progress({step: 'download', label: model, done: ev.completed ?? 0, total: ev.total, fraction: (ev.completed ?? 0) / ev.total});
            if (ev.status === 'success')
                break;
        }
        this.progress({step: 'done', label: '', fraction: 1});
    }
}

// Ollama reachable? Resolves to {ok, models: [names]}.
export async function ollamaStatus(url = 'http://127.0.0.1:11434', cancellable = null) {
    try {
        const data = await httpJson(`${url}/api/tags`, cancellable);
        return {ok: true, models: (data.models ?? []).map(m => m.name)};
    } catch {
        return {ok: false, models: []};
    }
}

// Ask the command engine to start the bundled Ollama (it may spawn; the
// preferences never do). Resolves to true when Ollama answers.
export function ensureOllama(cancellable = null) {
    return new Promise(resolve => {
        Gio.DBus.session.call('org.griffit.CommandHold', '/org/griffit/CommandHold', 'org.griffit.CommandHold',
            'EnsureOllama', null, new GLib.VariantType('(b)'), Gio.DBusCallFlags.NONE, 30000, cancellable,
            (conn, res) => {
                try {
                    resolve(conn.call_finish(res).deepUnpack()[0]);
                } catch {
                    resolve(false);
                }
            });
    });
}

// Log out through gnome-session (the engines and the extension start fresh).
export function logout() {
    Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
        'Logout', new GLib.Variant('(u)', [0]), null, Gio.DBusCallFlags.NONE, -1, null, null);
}

export function formatSize(bytes) {
    if (bytes >= 1e9)
        return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6)
        return `${Math.round(bytes / 1e6)} MB`;
    return `${Math.round(bytes / 1e3)} kB`;
}
