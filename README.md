# Command Hold

Hold a key and say what to do. Offline voice commands for GNOME Shell.

Third member of the Hold family, after [Accent Hold](https://github.com/d101c/accent-hold)
(press-and-hold accents) and [Voice Hold](https://github.com/d101c/voice-hold)
(press-and-speak dictation).

- **Hold `Super+C`** and speak, release: *"open Firefox"*, *"volume à la moitié"*,
  *"mode sombre"*, *"next workspace"*, *"lock the screen"*, *"screenshot"*,
  *"Wi-Fi off"*, *"ferme toutes les fenêtres"*… run at once.
- Anything else (*"clone le dépôt d101c slash voice hold dans développement"*,
  *"update the system"*, *"what is using my memory"*) becomes a shell command
  that you **see and confirm** (Enter) before it runs in a visible terminal.
  The pill then says *Running…*, *Done ✓* or *Failed ✗ (exit N)* with the last
  lines of output. `sudo` works: it is a real terminal.
- A quick **tap** keeps listening hands-free until you tap again, press Escape
  or stay silent for a few seconds.
- French and English (and the 23 other languages of the Voice Hold engine).
- 100 % local: nothing leaves your computer.

## How it understands you

1. **Rules** (< 1 ms): regular expressions tolerant to dictation noise, number
   words, and fuzzy matching of what you said against the applications
   actually installed. They cover every GNOME action and a few safe shell
   templates.
2. **A small local LLM** (optional, 2–4 s on a laptop CPU) through
   [Ollama](https://ollama.com), model `qwen3:1.7b` by default, only for what
   the rules leave: shell commands and questions. Its output is constrained to
   a JSON schema and never trusted for safety.
3. **Guard rails**, computed by the helper from the command text alone: a
   blacklist that refuses outright (`rm -rf /`, `mkfs`, `dd` to a disk, fork
   bombs, piping the network into a shell, account changes…), a grey list that
   adds a warning (`sudo`, `rm`, package managers, `git push --force`, `kill`…).
   Every command is shown before it runs; the LLM never sees command output.

Measured on an i7-8565U (4 cores, no GPU): a GNOME action lands ≈ 0.6 s after
the end of the sentence; a shell command is proposed ≈ 3 s later; memory
≈ 2.9 GB with both the speech model and the LLM loaded, released after idle.
Details in the feasibility study that preceded this project.

## Install

Three pieces, all local.

1. **Voice Hold engine** (speech recognition, shared with the Voice Hold
   extension):
   ```
   pipx install "git+https://github.com/d101c/voice-hold#subdirectory=engine" && voice-hold-engine setup
   ```
2. **Command engine** (this repository, `engine/`):
   ```
   pipx install "git+https://github.com/d101c/command-hold#subdirectory=engine" && command-hold-engine install-service
   ```
3. **Ollama and the model** (optional, for open requests):
   ```
   curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen3:1.7b
   ```
4. The extension: from extensions.gnome.org once published, or the zip of the
   latest release (`gnome-extensions install --force command-hold@griffit.gmail.com.shell-extension.zip`),
   then log out and back in and enable it.

`command-hold-engine status` checks everything; `command-hold-engine interpret
"ouvre firefox"` shows what a sentence would do, without doing it;
`command-hold-engine apps` lists the applications the rules know.

Requires GNOME Shell 45–50 on Wayland, PipeWire, Python ≥ 3.12, and a terminal
(Ptyxis, Console or GNOME Terminal).

## Settings

Shortcut (a modifier is required), gesture mode, tap threshold, silence
timeout, LLM on/off, model, Ollama URL, working folder for commands, pill and
top-bar indicator. The panel menu toggles the shortcut and the LLM and shows
the engine state without starting it.

## Security

The helper listens on the session bus without authentication, like every
session service: any process running as you can call it. It only runs what
the extension has shown and you have confirmed; refused commands are refused
whoever calls. Commands that ran are logged in
`~/.local/state/command-hold/history.log`. Brightness works on the internal
screen only. Super alone cannot be the shortcut (it is Mutter's overlay key).

## Development

```
cd engine && uv venv && uv pip install -e '.[test]' && .venv/bin/pytest
for t in extension/tests/*.test.js; do gjs -m "$t"; done
./pack.sh
```

Design: `docs/superpowers/specs/2026-11-03-command-hold-design.md`.

## Licences

Extension and helper: GPL-2.0-or-later (the "or later" is what makes the
combination with Apache-2.0 and MIT dependencies distributable). The helper
depends on dbus-fast (MIT). Ollama is MIT; Qwen3 weights are Apache-2.0 and
downloaded by you. Speech recognition comes from the Voice Hold engine
(sherpa-onnx Apache-2.0, Parakeet TDT 0.6B v3 CC-BY-4.0, Silero VAD MIT).

I used AI assistance (Claude) to write and review this code; every line is
mine to explain.
