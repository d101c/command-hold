"""Shell jobs: a command confirmed by the user runs in a visible terminal,
under `script` so it keeps a real pty (colours, sudo prompts), with its
output logged and its exit code written to a file the helper watches.

Files live in $XDG_RUNTIME_DIR/command-hold/<id>.{sh,log,exit}; the terminal
stays open after the command ("[exit N] Press Enter to close")."""
import asyncio
import os
import shlex
import shutil
import subprocess
import time
import uuid
from pathlib import Path

RUNNING = 'running'
DONE = 'done'
FAILED = 'failed'

POLL_S = 0.25
TAIL_LINES = 2
TAIL_CHARS = 160

TERMINALS = [
    ('ptyxis', ['ptyxis', '--new-window', '--']),
    ('kgx', ['kgx', '--']),
    ('gnome-terminal', ['gnome-terminal', '--']),
    ('xdg-terminal-exec', ['xdg-terminal-exec']),
]


def runtime_dir():
    base = os.environ.get('XDG_RUNTIME_DIR') or f'/tmp/command-hold-{os.getuid()}'
    d = Path(base) / 'command-hold'
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    return d


def history_file():
    base = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local' / 'state'))
    d = base / 'command-hold'
    d.mkdir(parents=True, exist_ok=True)
    return d / 'history.log'


def find_terminal():
    """Return (name, argv prefix) of the first terminal found, or None."""
    override = os.environ.get('COMMAND_HOLD_TERMINAL')
    if override:
        argv = shlex.split(override)
        return argv[0], argv
    for name, argv in TERMINALS:
        if shutil.which(name):
            return name, argv
    return None


WRAPPER = r'''#!/bin/bash
# Written by command-hold-engine. Runs one confirmed voice command.
CMD={cmd}
LOG={log}
EXIT={exit}
cd {cwd} 2>/dev/null || cd ~
printf '\033[1m$ %s\033[0m\n' "$CMD"
if command -v script >/dev/null 2>&1; then
    script -q -e -c "$CMD" "$LOG"
    code=$?
else
    bash -c "$CMD" 2>&1 | tee "$LOG"
    code=${{PIPESTATUS[0]}}
fi
echo "$code" > "$EXIT"
echo
if [ "$code" -eq 0 ]; then
    printf '\033[32m[exit 0]\033[0m Press Enter to close'
else
    printf '\033[31m[exit %s]\033[0m Press Enter to close' "$code"
fi
read -r
'''


def _tail(path):
    try:
        data = Path(path).read_bytes()[-4096:].decode('utf-8', 'replace')
    except OSError:
        return ''
    lines = [l.strip() for l in data.replace('\r\n', '\n').replace('\r', '\n').split('\n')]
    lines = [l for l in lines if l and not l.startswith('Script ')]
    text = ' · '.join(lines[-TAIL_LINES:])
    return text[-TAIL_CHARS:]


class JobRunner:
    def __init__(self, emit, *, loop=None, terminal=None, poll_s=POLL_S):
        self._emit = emit                 # emit(id, state, exit_code, tail)
        self._loop = loop
        self._terminal = terminal
        self._poll_s = poll_s
        self.jobs = {}                    # id -> {command, cwd, started, task}

    def start(self, command, cwd=''):
        """Write the wrapper, open the terminal, watch the exit file. Returns
        the job id. Raises RuntimeError when no terminal is available."""
        term = self._terminal or find_terminal()
        if not term:
            raise RuntimeError('no terminal emulator found (ptyxis, kgx, gnome-terminal)')
        jid = uuid.uuid4().hex[:8]
        d = runtime_dir()
        sh, log, exit_ = d / f'{jid}.sh', d / f'{jid}.log', d / f'{jid}.exit'
        cwd = os.path.expanduser(cwd) if cwd else str(Path.home())
        sh.write_text(WRAPPER.format(cmd=shlex.quote(command), log=shlex.quote(str(log)),
                                     exit=shlex.quote(str(exit_)), cwd=shlex.quote(cwd)))
        sh.chmod(0o700)
        log.touch()
        argv = list(term[1]) + ['bash', str(sh)]
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True, cwd=cwd)
        with history_file().open('a') as f:
            f.write(f'{time.strftime("%Y-%m-%d %H:%M:%S")} [{jid}] {cwd}: {command}\n')
        job = {'command': command, 'cwd': cwd, 'started': time.monotonic(), 'log': log, 'exit': exit_}
        self.jobs[jid] = job
        loop = self._loop or asyncio.get_event_loop()
        job['task'] = loop.create_task(self._watch(jid))
        self._emit(jid, RUNNING, -1, '')
        return jid

    async def _watch(self, jid):
        job = self.jobs[jid]
        while True:
            await asyncio.sleep(self._poll_s)
            try:
                raw = job['exit'].read_text().strip()
            except OSError:
                raw = ''
            if raw:
                try:
                    code = int(raw)
                except ValueError:
                    code = 1
                self._emit(jid, DONE if code == 0 else FAILED, code, _tail(job['log']))
                self._cleanup(jid)
                return
            if time.monotonic() - job['started'] > 6 * 3600:
                self._emit(jid, FAILED, -1, 'gave up watching after 6 hours')
                self._cleanup(jid)
                return

    def _cleanup(self, jid):
        job = self.jobs.pop(jid, None)
        if not job:
            return
        for k in ('log', 'exit'):
            try:
                job[k].unlink()
            except OSError:
                pass
        try:
            (job['exit'].parent / f'{jid}.sh').unlink()
        except OSError:
            pass

    @property
    def active(self):
        return bool(self.jobs)

    def cancel_all(self):
        for jid in list(self.jobs):
            job = self.jobs[jid]
            job['task'].cancel()
            self.jobs.pop(jid, None)
