"""What was heard and what came of it, kept on disk so the user can look
back at the last requests: $XDG_STATE_HOME/command-hold/history.jsonl, one
JSON object per line, newest last. Bounded."""
import json
import os
import time
import uuid
from pathlib import Path

MAX_ENTRIES = 200
RESULT_CHARS = 6000


def default_path():
    base = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local' / 'state'))
    return base / 'command-hold' / 'history.jsonl'


class History:
    def __init__(self, path=None, max_entries=MAX_ENTRIES):
        self.path = Path(path) if path else default_path()
        self.max_entries = max_entries
        self._entries = None

    def _load(self):
        if self._entries is not None:
            return
        self._entries = []
        try:
            for line in self.path.read_text().splitlines():
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if isinstance(e, dict) and e.get('id'):
                    self._entries.append(e)
        except OSError:
            pass
        self._entries = self._entries[-self.max_entries:]

    def _save(self):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix('.tmp')
            tmp.write_text(''.join(json.dumps(e, ensure_ascii=False) + '\n' for e in self._entries))
            tmp.replace(self.path)
        except OSError:
            pass

    def add(self, transcript, action, *, command='', say='', source=''):
        """Record a request. Returns its id."""
        self._load()
        e = {'id': uuid.uuid4().hex[:8], 'ts': time.strftime('%Y-%m-%d %H:%M:%S'),
             'transcript': transcript, 'action': action, 'command': command, 'say': say,
             'source': source, 'result': '', 'exit': None}
        self._entries.append(e)
        self._entries = self._entries[-self.max_entries:]
        self._save()
        return e['id']

    def note(self, eid, result, exit_code=None):
        """Attach the outcome (the text the pill showed, a command's output)."""
        self._load()
        for e in reversed(self._entries):
            if e['id'] == eid:
                e['result'] = str(result)[:RESULT_CHARS]
                if exit_code is not None:
                    e['exit'] = int(exit_code)
                self._save()
                return True
        return False

    def last(self, n=5):
        """The newest n entries, newest first."""
        self._load()
        n = max(0, int(n))
        return list(reversed(self._entries[-n:])) if n else []

    def clear(self):
        self._load()
        self._entries = []
        self._save()
