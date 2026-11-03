"""Command line: `command-hold-engine [serve|status|interpret TEXT|apps|install-service|uninstall]`."""
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from . import BUS_NAME, __version__

SERVICE_FILE = f'{BUS_NAME}.service'


def service_dir():
    data = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local' / 'share'))
    return data / 'dbus-1' / 'services'


def service_exec():
    """The interpreter running this command (the venv's python with pipx or
    uv). Never resolve() it: a venv's python is a symlink to the system
    interpreter, which cannot import us."""
    return f'{sys.executable} -m command_hold_engine serve'


def install_service(log=print):
    d = service_dir()
    d.mkdir(parents=True, exist_ok=True)
    path = d / SERVICE_FILE
    path.write_text(f'[D-BUS Service]\nName={BUS_NAME}\nExec={service_exec()}\n')
    log(f'D-Bus service installed: {path}')
    return path


def cmd_serve(args):
    from .service import serve
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        pass
    return 0


def cmd_status(args):
    from . import jobs, llm
    print(f'command-hold-engine {__version__}')
    svc = service_dir() / SERVICE_FILE
    print(f'D-Bus service file: {svc} ({"present" if svc.exists() else "absent"})')
    ok, model = llm.ping()
    print(f'ollama: {"reachable" if ok else "NOT reachable"} ({llm.DEFAULT_URL}); model {llm.DEFAULT_MODEL}: {"present" if model else "missing"}')
    term = jobs.find_terminal()
    print(f'terminal: {term[0] if term else "NOT FOUND (install ptyxis or gnome-terminal)"}')
    vh = service_dir() / 'org.griffit.VoiceHold.service'
    print(f'voice-hold-engine service: {"present" if vh.exists() else "absent (install Voice Hold first)"}')
    return 0 if svc.exists() and term and vh.exists() else 1


def cmd_interpret(args):
    from .interpreter import Interpreter
    it = Interpreter(use_llm=not args.no_llm)
    intent = it.interpret(' '.join(args.text))
    print(json.dumps(intent, ensure_ascii=False, indent=1))
    return 0


def cmd_apps(args):
    from .apps import list_apps
    for a in list_apps(force=True):
        print(f"{a['id']:40} {a['name']}" + (f"  ({a['name_fr']})" if a['name_fr'] else ''))
    return 0


def cmd_uninstall(args):
    svc = service_dir() / SERVICE_FILE
    if svc.exists():
        svc.unlink()
        print(f'Removed {svc}')
    print('Now run: pipx uninstall command-hold-engine  (or: uv tool uninstall command-hold-engine)')
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog='command-hold-engine', description=__doc__)
    p.add_argument('--version', action='version', version=__version__)
    sub = p.add_subparsers(dest='cmd')
    sub.add_parser('serve', help='run the D-Bus service (default)').set_defaults(fn=cmd_serve)
    sub.add_parser('status', help='check the service file, Ollama, the terminal and Voice Hold').set_defaults(fn=cmd_status)
    i = sub.add_parser('interpret', help='print the intent for a sentence, without running anything')
    i.add_argument('--no-llm', action='store_true')
    i.add_argument('text', nargs='+')
    i.set_defaults(fn=cmd_interpret)
    sub.add_parser('apps', help='list the applications the rules know').set_defaults(fn=cmd_apps)
    sub.add_parser('install-service', help='(re)write the D-Bus service file').set_defaults(fn=lambda a: (install_service(), 0)[1])
    sub.add_parser('uninstall', help='remove the D-Bus service file').set_defaults(fn=cmd_uninstall)
    args = p.parse_args(argv)
    fn = getattr(args, 'fn', cmd_serve)
    return fn(args)


if __name__ == '__main__':
    sys.exit(main())
