#!/usr/bin/env bash
# Build the uploadable bundle for extensions.gnome.org.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO/extension"
SCHEMA="schemas/org.gnome.shell.extensions.command-hold.gschema.xml"
ZIP="$REPO/command-hold@griffit.gmail.com.shell-extension.zip"
PODIR=()
[ -d "$SRC/po" ] && PODIR=(--podir=po --gettext-domain=command-hold)
gnome-extensions pack "$SRC" \
  --extra-source=actions.js --extra-source=commander.js --extra-source=confirmDialog.js \
  --extra-source=dispatch.js --extra-source=engine.js --extra-source=holdMachine.js \
  --extra-source=hud.js --extra-source=keyHook.js --extra-source=panelIndicator.js \
  --extra-source=voice.js --extra-source=setup.js --extra-source=setupPage.js \
  "${PODIR[@]}" --schema="$SCHEMA" --out-dir="$REPO" --force
( cd "$SRC" && zip -r -q "$ZIP" icons )
echo "Built: $ZIP"
