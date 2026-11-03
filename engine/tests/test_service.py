"""The D-Bus interface class, called directly (no bus)."""
import asyncio

import pytest
from dbus_fast import DBusError, Variant

from command_hold_engine import service
from command_hold_engine.interpreter import Interpreter


class FakeRunner:
    def __init__(self):
        self.started = []
        self.jobs = {}

    def start(self, command, cwd):
        self.started.append((command, cwd))
        return 'job1'

    @property
    def active(self):
        return bool(self.jobs)


def unwrap(iface_fn):
    return getattr(iface_fn, '__wrapped__', iface_fn)


async def test_interpret_returns_variants(fake_apps):
    loop = asyncio.get_running_loop()
    it = Interpreter(apps=fake_apps, use_llm=False)
    iface = service.CommandHoldInterface(loop, warm_up=False, interpreter=it, runner=FakeRunner())
    out = await unwrap(iface.Interpret)(iface, 'ouvre firefox', {'llm': Variant('b', False)})
    assert out['action'].value == 'open_app' and out['app_id'].value == 'firefox_firefox.desktop'
    assert out['needs_confirmation'].value is False and out['refused'].value is False
    assert isinstance(out['ms'].value, int)


async def test_interpret_passes_options_and_guards(fake_apps):
    loop = asyncio.get_running_loop()
    seen = {}

    def fake_llm(text, url, model):
        seen.update(url=url, model=model)
        return {'action': 'run_shell', 'command': 'rm -rf /'}
    it = Interpreter(apps=fake_apps, llm_fn=fake_llm)
    iface = service.CommandHoldInterface(loop, warm_up=False, interpreter=it, runner=FakeRunner())
    opts = {'llm-model': Variant('s', 'qwen3:4b'), 'llm-url': Variant('s', 'http://x:1'), 'work-dir': Variant('s', '~/DEVELOPEMENT')}
    out = await unwrap(iface.Interpret)(iface, 'optimise tout', opts)
    assert seen == {'url': 'http://x:1', 'model': 'qwen3:4b'}
    assert out['refused'].value is True and out['cwd'].value == '~/DEVELOPEMENT'


async def test_run_refuses_blacklist_and_delegates(fake_apps):
    loop = asyncio.get_running_loop()
    runner = FakeRunner()
    iface = service.CommandHoldInterface(loop, warm_up=False, interpreter=Interpreter(apps=fake_apps, use_llm=False), runner=runner)
    with pytest.raises(DBusError):
        unwrap(iface.Run)(iface, 'rm -rf /', '')
    assert unwrap(iface.Run)(iface, 'df -h', '~') == 'job1'
    assert runner.started == [('df -h', '~')]


async def test_idle_exits_only_without_jobs(fake_apps, monkeypatch):
    loop = asyncio.get_running_loop()
    runner = FakeRunner()
    iface = service.CommandHoldInterface(loop, warm_up=False, interpreter=Interpreter(apps=fake_apps, use_llm=False), runner=runner)
    runner.jobs['j'] = {}
    iface._on_idle()
    assert not iface.exit_event.is_set()
    runner.jobs.clear()
    iface._on_idle()
    assert iface.exit_event.is_set()


async def test_status_shape(fake_apps, monkeypatch):
    loop = asyncio.get_running_loop()
    monkeypatch.setattr(service.llm, 'ping', lambda url, model: (True, False))
    iface = service.CommandHoldInterface(loop, warm_up=False, interpreter=Interpreter(apps=fake_apps, use_llm=False), runner=FakeRunner())
    st = unwrap(iface.Status)(iface)
    assert st['ollama'].value is True and st['model'].value is False and st['apps'].value == len(fake_apps)
