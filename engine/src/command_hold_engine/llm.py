"""Open requests go to a local LLM through Ollama (`/api/chat`, constrained
JSON output). The prompt is long and constant so the server's prefix cache
makes every call after the first cheap. Anything that goes wrong returns
None: the caller then answers "LLM unavailable"."""
import json
import re
import urllib.error
import urllib.request

ACTIONS = [
    'open_app', 'close_window', 'close_all_windows', 'set_volume', 'change_volume',
    'set_brightness', 'change_brightness', 'toggle_dark_mode', 'toggle_dnd',
    'toggle_wifi', 'toggle_bluetooth', 'switch_workspace', 'screenshot', 'lock',
    'power', 'run_shell', 'answer', 'unknown',
]

SCHEMA = {
    'type': 'object',
    'properties': {
        'action': {'type': 'string', 'enum': ACTIONS},
        'name': {'type': 'string'},
        'percent': {'type': 'integer'},
        'delta': {'type': 'integer'},
        'enable': {'type': 'boolean'},
        'n': {'type': ['integer', 'string']},
        'target': {'type': 'string', 'enum': ['screen', 'window', 'area']},
        'power_action': {'type': 'string', 'enum': ['suspend', 'reboot', 'shutdown', 'logout']},
        'command': {'type': 'string'},
        'needs_confirmation': {'type': 'boolean'},
        'text': {'type': 'string'},
    },
    'required': ['action'],
}

SYSTEM = """You are the intent parser of an offline voice assistant that controls a GNOME Linux desktop (Ubuntu). The user speaks French or English (sometimes mixed, with hesitations like "euh" or speech-recognition mistakes). You receive the transcript and must answer with ONE JSON object and nothing else.

Available actions and their fields:
- open_app {name}: launch an application. name = the application as spoken (firefox, terminal, settings, files, spotify...).
- close_window {}: close the active window.
- close_all_windows {}: close every window.
- set_volume {percent}: set the output volume, 0-100. "mute" / "coupe le son" = 0. "half" / "la moitié" = 50.
- change_volume {delta}: raise (+10) or lower (-10) the volume when no exact value is given.
- set_brightness {percent}: set screen brightness 0-100.
- change_brightness {delta}: raise (+10) or lower (-10) brightness.
- toggle_dark_mode {enable}: true = dark theme, false = light theme.
- toggle_dnd {enable}: true = do not disturb on (notifications silenced), false = notifications back on.
- toggle_wifi {enable}, toggle_bluetooth {enable}: true = on, false = off.
- switch_workspace {n}: n is a 1-based integer, or "next" / "prev".
- screenshot {target}: "screen" (whole screen), "window" (active window) or "area".
- lock {}: lock the screen.
- power {power_action, needs_confirmation}: suspend | reboot | shutdown | logout. needs_confirmation is always true.
- run_shell {command, needs_confirmation}: anything else that can be done with a Linux shell command (git, apt, df, free, ping, find...). Write a single bash command line. needs_confirmation = true when the command modifies the system or files (install, update, remove, delete, kill, sudo, write), false when it is read-only (df, free, ls, git status, ping, cat).
- answer {text}: the user asks a question that needs no command; text = a one-sentence answer.
- unknown {}: the request is ambiguous, incomplete, chit-chat, or nothing to do (e.g. "thanks", "never mind", "open the thing", "set the volume" without a value).

Rules:
1. Output only the JSON object. No prose, no markdown.
2. Never invent a destructive command for a vague request ("optimise the computer", "format the usb key"): either use unknown, or run_shell with needs_confirmation true and a safe, explicit command.
3. Prefer the dedicated GNOME action over run_shell when one exists (volume, brightness, dark mode, lock, screenshot, workspace, wifi, bluetooth, opening apps).
4. Keep names as spoken, lower case ("fire fox" -> "firefox").
5. The home folder is ~, the development folder is ~/DEVELOPEMENT. GitHub repos "owner slash repo" mean https://github.com/owner/repo.

Examples:
"ouvre firefox" -> {"action":"open_app","name":"firefox"}
"mets le volume à 30" -> {"action":"set_volume","percent":30}
"passe en mode sombre" -> {"action":"toggle_dark_mode","enable":true}
"quelle est la place libre sur le disque" -> {"action":"run_shell","command":"df -h ~","needs_confirmation":false}
"installe vlc" -> {"action":"run_shell","command":"sudo apt install -y vlc","needs_confirmation":true}
"redémarre" -> {"action":"power","power_action":"reboot","needs_confirmation":true}
"merci" -> {"action":"unknown"}
"""

DEFAULT_URL = 'http://127.0.0.1:11434'
DEFAULT_MODEL = 'qwen3:1.7b'
TIMEOUT_S = 8.0          # once the model is loaded
COLD_TIMEOUT_S = 90.0    # first call: the weights are read from disk
KEEP_ALIVE = '30m'


def _post(url, payload, timeout, opener=None):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={'Content-Type': 'application/json'})
    f = (opener or urllib.request.urlopen)(req, timeout=timeout)
    with f:
        return json.loads(f.read().decode())


def interpret(text, *, url=DEFAULT_URL, model=DEFAULT_MODEL, timeout=None, opener=None):
    """Return the parsed intent dict, or None when Ollama is unreachable, slow
    or answers garbage. Without an explicit timeout, a model that is not
    loaded yet gets the cold one."""
    if timeout is None:
        timeout = TIMEOUT_S if loaded(url, model, opener=opener) else COLD_TIMEOUT_S
    payload = {
        'model': model,
        'messages': [{'role': 'system', 'content': SYSTEM},
                     {'role': 'user', 'content': text}],
        'format': SCHEMA,
        'stream': False,
        'think': False,
        'keep_alive': KEEP_ALIVE,
        'options': {'temperature': 0, 'num_thread': 4, 'num_predict': 160},
    }
    try:
        data = _post(f'{url.rstrip("/")}/api/chat', payload, timeout, opener)
        content = data['message']['content']
    except (urllib.error.URLError, OSError, KeyError, TypeError, ValueError):
        return None
    return parse(content)


def parse(content):
    """Pull one JSON object out of a model answer. None if there is none or it
    has no valid action."""
    if not isinstance(content, str):
        return None
    s = content.strip()
    s = re.sub(r'^```(?:json)?\s*|\s*```$', '', s)
    try:
        obj = json.loads(s)
    except ValueError:
        m = re.search(r'\{.*\}', s, re.S)
        if not m:
            return None
        try:
            obj = json.loads(m.group())
        except ValueError:
            return None
    if not isinstance(obj, dict) or obj.get('action') not in ACTIONS:
        return None
    return obj


def ping(url=DEFAULT_URL, model=DEFAULT_MODEL, timeout=2.0, opener=None):
    """Return (reachable, model_present)."""
    try:
        req = urllib.request.Request(f'{url.rstrip("/")}/api/tags')
        with (opener or urllib.request.urlopen)(req, timeout=timeout) as f:
            data = json.loads(f.read().decode())
    except (urllib.error.URLError, OSError, ValueError):
        return False, False
    names = {m.get('name', '') for m in data.get('models', [])}
    want = model if ':' in model else model + ':latest'
    return True, want in names or model in names


def loaded(url=DEFAULT_URL, model=DEFAULT_MODEL, timeout=1.0, opener=None):
    """True when Ollama reports the model as currently loaded (/api/ps)."""
    try:
        req = urllib.request.Request(f'{url.rstrip("/")}/api/ps')
        with (opener or urllib.request.urlopen)(req, timeout=timeout) as f:
            data = json.loads(f.read().decode())
    except (urllib.error.URLError, OSError, ValueError):
        return False
    want = model if ':' in model else model + ':latest'
    return any(m.get('name') in (model, want) or m.get('model') in (model, want) for m in data.get('models', []))


def warm_up(url=DEFAULT_URL, model=DEFAULT_MODEL, opener=None):
    """Load the model now so the first real request does not pay the cold
    start. Returns True when the model answered."""
    try:
        _post(f'{url.rstrip("/")}/api/generate',
              {'model': model, 'prompt': '', 'keep_alive': KEEP_ALIVE, 'options': {'num_thread': 4}},
              COLD_TIMEOUT_S, opener)
        return True
    except (urllib.error.URLError, OSError, ValueError):
        return False
