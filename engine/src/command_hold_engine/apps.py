"""Installed applications, read from .desktop files (no PyGObject needed).

Each app: {id, name, name_fr, generic, generic_fr, keywords, exec}. The list
is cached for a minute: a voice command must not pay a directory walk."""
import configparser
import glob
import os
import time
from pathlib import Path

DIRS = [
    Path.home() / '.local/share/applications',
    Path('/usr/share/applications'),
    Path('/usr/local/share/applications'),
    Path('/var/lib/flatpak/exports/share/applications'),
    Path.home() / '.local/share/flatpak/exports/share/applications',
    Path('/var/lib/snapd/desktop/applications'),
]
CACHE_S = 60.0

_cache = {'at': 0.0, 'apps': []}


def _split(v):
    return [k for k in (v or '').split(';') if k]


def read_desktop(path):
    cp = configparser.RawConfigParser(strict=False, interpolation=None)
    try:
        cp.read(path, encoding='utf-8')
        e = cp['Desktop Entry']
    except Exception:
        return None
    if e.get('Type', 'Application') != 'Application':
        return None
    if e.get('NoDisplay', 'false').lower() == 'true' or e.get('Hidden', 'false').lower() == 'true':
        return None
    if 'OnlyShowIn' in e and 'GNOME' not in _split(e.get('OnlyShowIn')):
        return None
    if 'GNOME' in _split(e.get('NotShowIn')):
        return None
    exe = (e.get('Exec') or '').split(' ')[0].split('/')[-1]
    return {
        'id': os.path.basename(path),
        'name': e.get('Name', ''),
        'name_fr': e.get('Name[fr]', ''),
        'generic': e.get('GenericName', ''),
        'generic_fr': e.get('GenericName[fr]', ''),
        'keywords': _split(e.get('Keywords')) + _split(e.get('Keywords[fr]')),
        'exec': exe,
    }


def list_apps(dirs=None, force=False):
    now = time.monotonic()
    if not force and dirs is None and _cache['apps'] and now - _cache['at'] < CACHE_S:
        return _cache['apps']
    seen, apps = set(), []
    for d in dirs or DIRS:
        for f in sorted(glob.glob(str(d / '*.desktop'))):
            did = os.path.basename(f)
            if did in seen:
                continue
            seen.add(did)
            app = read_desktop(f)
            if app:
                apps.append(app)
    if dirs is None:
        _cache.update(at=now, apps=apps)
    return apps
