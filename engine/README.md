# command-hold-engine

The helper behind the [Command Hold](../README.md) GNOME Shell extension:
a session D-Bus service (`org.griffit.CommandHold`) that turns a spoken
sentence into an intent (rules first, then a local LLM through Ollama),
applies the guard rails, and runs confirmed shell commands in a visible
terminal while reporting their state.

    pipx install "git+https://github.com/d101c/command-hold#subdirectory=engine"
    command-hold-engine install-service
    command-hold-engine status
    command-hold-engine interpret "ouvre firefox"

Speech recognition is done by the Voice Hold engine (`org.griffit.VoiceHold`),
which must be installed too. GPL-2.0-or-later.
