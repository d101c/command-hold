"""Start the Ollama bundle the setup assistant unpacks into
$XDG_DATA_HOME/hold/ollama when no Ollama answers on the local port. The
preferences window never spawns anything; this helper does, once, and the
process outlives it (detached)."""
import os
import subprocess
import time
from pathlib import Path

from . import llm


def bundle_dir():
    base = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local' / 'share'))
    return base / 'hold' / 'ollama'


def bundled_binary():
    b = bundle_dir() / 'bin' / 'ollama'
    return b if b.is_file() and os.access(b, os.X_OK) else None


def ensure(url=llm.DEFAULT_URL, wait_s=15.0, spawn=subprocess.Popen):
    """Return True when Ollama answers; start the bundled one if needed."""
    if llm.ping(url)[0]:
        return True
    binary = bundled_binary()
    if not binary:
        return False
    env = dict(os.environ)
    env.setdefault('OLLAMA_MODELS', str(bundle_dir() / 'models'))
    env['OLLAMA_KEEP_ALIVE'] = env.get('OLLAMA_KEEP_ALIVE', '30m')
    log = open(bundle_dir() / 'serve.log', 'ab')
    spawn([str(binary), 'serve'], stdin=subprocess.DEVNULL, stdout=log, stderr=log,
          start_new_session=True, env=env, cwd=str(bundle_dir()))
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline:
        time.sleep(0.5)
        if llm.ping(url)[0]:
            return True
    return False
