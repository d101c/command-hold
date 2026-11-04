"""Read-only commands run here, silently: no terminal, no confirmation. The
output comes back to the pill. Bounded in time and size; a command that
hangs is killed."""
import os
import subprocess
from pathlib import Path

TIMEOUT_S = 12.0
MAX_LINES = 80
MAX_CHARS = 6000


def trim(text, max_lines=MAX_LINES, max_chars=MAX_CHARS):
    """Keep the head of the output; say how much was left out."""
    text = text.replace('\r\n', '\n').replace('\r', '\n').rstrip()
    lines = text.split('\n')
    cut = False
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        cut = True
    text = '\n'.join(lines)
    if len(text) > max_chars:
        text = text[:max_chars].rstrip()
        cut = True
    return text + ('\n…' if cut else '')


def run(command, cwd='', timeout=TIMEOUT_S):
    """Run a read-only command line in bash. Returns (exit_code, output):
    stdout and stderr together, trimmed. exit_code 124 = killed on timeout."""
    cwd = os.path.expanduser(cwd) if cwd else str(Path.home())
    if not os.path.isdir(cwd):
        cwd = str(Path.home())
    env = dict(os.environ, PAGER='cat', GIT_PAGER='cat', SYSTEMD_PAGER='', TERM='dumb', COLUMNS='100')
    try:
        p = subprocess.run(['bash', '-c', command], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout,
                           start_new_session=True)
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b'').decode('utf-8', 'replace')
        return 124, trim(out + ('\n' if out else '') + f'[stopped after {int(timeout)} s]')
    except OSError as e:
        return 127, str(e)
    return p.returncode, trim(p.stdout.decode('utf-8', 'replace'))
