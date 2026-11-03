"""Jobs on a fake terminal: a script that runs the wrapper in the background
with stdin closed (so the final `read` returns at once)."""
import asyncio
import os
import stat

import pytest

from command_hold_engine import jobs


@pytest.fixture
def fake_terminal(tmp_path, monkeypatch):
    term = tmp_path / 'fake-term'
    term.write_text('#!/bin/bash\n# argv: bash <script>\nnohup "$@" </dev/null >/dev/null 2>&1 &\n')
    term.chmod(term.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv('COMMAND_HOLD_TERMINAL', str(term))
    monkeypatch.setenv('XDG_RUNTIME_DIR', str(tmp_path / 'run'))
    monkeypatch.setenv('XDG_STATE_HOME', str(tmp_path / 'state'))
    return term


async def _collect(runner, events, want):
    for _ in range(200):
        await asyncio.sleep(0.05)
        if any(e[1] in (jobs.DONE, jobs.FAILED) for e in events):
            return
    raise AssertionError(f'no terminal state in {events}')


async def test_success_reports_done_and_tail(fake_terminal, tmp_path):
    events = []
    runner = jobs.JobRunner(lambda *a: events.append(a), loop=asyncio.get_running_loop(), poll_s=0.05)
    jid = runner.start('echo hello; echo world', str(tmp_path))
    assert events[0] == (jid, jobs.RUNNING, -1, '')
    await _collect(runner, events, jobs.DONE)
    last = events[-1]
    assert last[0] == jid and last[1] == jobs.DONE and last[2] == 0
    assert 'world' in last[3]
    assert not runner.active
    hist = (tmp_path / 'state' / 'command-hold' / 'history.log').read_text()
    assert 'echo hello' in hist


async def test_failure_reports_exit_code(fake_terminal, tmp_path):
    events = []
    runner = jobs.JobRunner(lambda *a: events.append(a), loop=asyncio.get_running_loop(), poll_s=0.05)
    runner.start('echo oops; exit 3', str(tmp_path))
    await _collect(runner, events, jobs.FAILED)
    assert events[-1][1] == jobs.FAILED and events[-1][2] == 3


async def test_runs_in_requested_cwd(fake_terminal, tmp_path):
    d = tmp_path / 'work'
    d.mkdir()
    events = []
    runner = jobs.JobRunner(lambda *a: events.append(a), loop=asyncio.get_running_loop(), poll_s=0.05)
    runner.start('pwd', str(d))
    await _collect(runner, events, jobs.DONE)
    assert str(d) in events[-1][3]


def test_no_terminal_raises(monkeypatch, tmp_path):
    monkeypatch.setenv('XDG_RUNTIME_DIR', str(tmp_path))
    monkeypatch.delenv('COMMAND_HOLD_TERMINAL', raising=False)
    monkeypatch.setattr(jobs.shutil, 'which', lambda n: None)
    runner = jobs.JobRunner(lambda *a: None, loop=asyncio.new_event_loop())
    with pytest.raises(RuntimeError):
        runner.start('ls')


def test_wrapper_quotes_the_command(fake_terminal, tmp_path):
    runner = jobs.JobRunner(lambda *a: None, loop=asyncio.new_event_loop(), poll_s=10)
    jid = runner.start("echo 'it''s \"quoted\" $HOME'", str(tmp_path))
    sh = (tmp_path / 'run' / 'command-hold' / f'{jid}.sh').read_text()
    assert "CMD='echo '\"'\"'it'\"'\"''\"'\"'s \"quoted\" $HOME'\"'\"''" in sh
    runner.cancel_all()
