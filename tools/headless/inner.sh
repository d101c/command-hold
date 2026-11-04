#!/usr/bin/env bash
# Runs inside the private D-Bus session set up by run.sh.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; T="$S/env"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.desktop.input-sources sources "[('xkb','fr')]"
gsettings set org.gnome.desktop.interface color-scheme prefer-dark
gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800 --wayland-display=wayland-t > "$T/shell.log" 2>&1 &
SH=$!
sleep 6
gnome-extensions enable command-hold@griffit.gmail.com
gnome-extensions enable snap@test
# The real settings of this run (the private dconf): LLM on, no voice.
gsettings set org.gnome.shell.extensions.command-hold speak false
sleep 2
echo "dconf=$(ls "$XDG_CONFIG_HOME/dconf" 2>/dev/null) bus=$DBUS_SESSION_BUS_ADDRESS" >&2
python3 "$S/inject.py" "go $1"
sleep 0.8; touch "$S/frames/stop"; sleep 0.5
dbus-send --session --print-reply --dest=org.griffit.CommandHold /org/griffit/CommandHold org.griffit.CommandHold.History int32:5 2>/dev/null | tail -n +2
dbus-send --session --dest=org.griffit.VoiceHold /org/griffit/VoiceHold org.griffit.VoiceHold.Quit >/dev/null 2>&1
dbus-send --session --dest=org.griffit.CommandHold /org/griffit/CommandHold org.griffit.CommandHold.Quit >/dev/null 2>&1
sleep 0.5
kill $SH; wait $SH 2>/dev/null
echo "=== shell.log (command-hold lines)"; grep -i -E "command-hold|JS ERROR|too much|not in the stage" "$T/shell.log" | tail -30
echo "=== frames: $(ls "$S"/frames/f*.png 2>/dev/null | wc -l)"
