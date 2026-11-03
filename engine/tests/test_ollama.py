import os
import stat

from command_hold_engine import ollama


def test_ensure_returns_true_when_already_up(monkeypatch):
    monkeypatch.setattr(ollama.llm, 'ping', lambda url: (True, True))
    assert ollama.ensure(spawn=lambda *a, **k: (_ for _ in ()).throw(AssertionError('must not spawn'))) is True


def test_ensure_false_without_bundle(monkeypatch, tmp_path):
    monkeypatch.setenv('XDG_DATA_HOME', str(tmp_path))
    monkeypatch.setattr(ollama.llm, 'ping', lambda url: (False, False))
    assert ollama.ensure(spawn=lambda *a, **k: None) is False


def test_ensure_spawns_bundle_and_waits(monkeypatch, tmp_path):
    monkeypatch.setenv('XDG_DATA_HOME', str(tmp_path))
    b = tmp_path / 'hold' / 'ollama' / 'bin'
    b.mkdir(parents=True)
    (b / 'ollama').write_text('#!/bin/sh\n')
    (b / 'ollama').chmod(0o755)
    pings = iter([(False, False), (False, False), (True, True)])
    monkeypatch.setattr(ollama.llm, 'ping', lambda url: next(pings))
    monkeypatch.setattr(ollama.time, 'sleep', lambda s: None)
    spawned = []
    assert ollama.ensure(spawn=lambda argv, **k: spawned.append((argv, k))) is True
    assert spawned and spawned[0][0] == [str(b / 'ollama'), 'serve']
    assert spawned[0][1]['env']['OLLAMA_MODELS'] == str(tmp_path / 'hold' / 'ollama' / 'models')
