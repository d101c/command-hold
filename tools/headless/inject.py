# Inject key events into the headless shell through Mutter's RemoteDesktop.
# Usage: inject.py "down:meta r p:9000 up:meta"
#   name        tap (press + release)
#   down:name   press and keep
#   up:name     release
#   p:ms        pause
import os
import sys
import time

from gi.repository import Gio, GLib

CODES = {"meta": 125, "r": 19, "c": 46, "esc": 1, "sp": 57, "ret": 28, "a": 16, "e": 18}
bus = Gio.bus_get_sync(Gio.BusType.SESSION)


def call(path, iface, method, args=None, sig=None):
    return bus.call_sync('org.gnome.Mutter.RemoteDesktop', path, iface, method, args,
                         GLib.VariantType(sig) if sig else None, 0, -1, None)


path = call('/org/gnome/Mutter/RemoteDesktop', 'org.gnome.Mutter.RemoteDesktop',
            'CreateSession', None, '(o)').unpack()[0]
S = 'org.gnome.Mutter.RemoteDesktop.Session'
call(path, S, 'Start')
time.sleep(0.3)


def key(code, pressed):
    call(path, S, 'NotifyKeyboardKeycode', GLib.Variant('(ub)', (code, pressed)))


for tok in sys.argv[1].split():
    if tok.startswith('p:'):
        time.sleep(int(tok[2:]) / 1000)
    elif tok == 'go':
        # Start the frame grabber (snap@test) from inside the same virtual
        # keyboard session: closing a session makes GTK redraw a stale preedit.
        open(os.path.join(os.environ['SNAP_DIR'], 'go'), 'w').close()
        time.sleep(0.5)
    elif tok.startswith('down:'):
        key(CODES[tok[5:]], True)
    elif tok.startswith('up:'):
        key(CODES[tok[3:]], False)
    else:
        key(CODES[tok], True)
        time.sleep(0.05)
        key(CODES[tok], False)
    time.sleep(0.12)
call(path, S, 'Stop')
