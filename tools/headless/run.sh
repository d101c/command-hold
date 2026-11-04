#!/usr/bin/env bash
# Command Hold in a headless GNOME Shell, isolated from the user's session:
# private HOME/XDG dirs and D-Bus session (nothing touches the real dconf or
# history). Both engines are D-Bus-activated inside that session; the Voice
# Hold engine reads a WAV file instead of the microphone. Frames of the top of
# the screen (the island) land in tools/headless/frames.
#
#   tools/headless/run.sh [wav] [key sequence]
set -u
S="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$S/../.." && pwd)"; T="$S/env"
WAV="${1:-$REPO/engine/tests/data/disk-space-fr.wav}"
SEQ="${2:-down:meta c p:5500 up:meta p:9000}"
VH="${VOICE_HOLD_REPO:-$HOME/DEVELOPEMENT/voice-hold}"
VH_ENGINE="${VH_ENGINE:-$VH/engine/.venv/bin/voice-hold-engine}"
CH_PY="${CH_PY:-$REPO/engine/.venv/bin/python}"
MODELS="${VOICE_HOLD_MODELS:-$HOME/.local/share/voice-hold/models}"

rm -rf "$T"; RT=$(mktemp -d /tmp/chd.XXXX)
mkdir -p "$T/config" "$T/state" "$T/data/gnome-shell/extensions" "$T/data/dbus-1/services" "$S/frames"
rm -f "$S"/frames/*
cp -r "$REPO/extension" "$T/data/gnome-shell/extensions/command-hold@griffit.gmail.com"
glib-compile-schemas "$T/data/gnome-shell/extensions/command-hold@griffit.gmail.com/schemas"
cp -r "$S/snap@test" "$T/data/gnome-shell/extensions/"
printf '[D-BUS Service]\nName=org.griffit.VoiceHold\nExec=%s serve\n' "$VH_ENGINE" \
  > "$T/data/dbus-1/services/org.griffit.VoiceHold.service"
printf '[D-BUS Service]\nName=org.griffit.CommandHold\nExec=%s -m command_hold_engine serve\n' "$CH_PY" \
  > "$T/data/dbus-1/services/org.griffit.CommandHold.service"

env -u WAYLAND_DISPLAY -u DISPLAY -u DBUS_SESSION_BUS_ADDRESS \
  HOME="$T" XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" XDG_CACHE_HOME="$RT/c" \
  XDG_STATE_HOME="$T/state" XDG_RUNTIME_DIR="$RT" SNAP_DIR="$S/frames" GSETTINGS_BACKEND=dconf \
  VOICE_HOLD_AUDIO_FILE="$WAV" VOICE_HOLD_MODELS="$MODELS" VOICE_HOLD_IDLE_S=20 COMMAND_HOLD_IDLE_S=30 \
  dbus-run-session -- "$S/inner.sh" "$SEQ"
rm -rf "$RT" 2>/dev/null
