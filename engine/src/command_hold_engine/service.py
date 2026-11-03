"""D-Bus face of the helper: org.griffit.CommandHold.

Interpret runs the rules on the loop (microseconds) and the LLM call on a
worker thread (seconds). Jobs are watched on the loop. The process exits
after IDLE_S without a call and with no job running."""
import asyncio
import os
import shutil
from concurrent.futures import ThreadPoolExecutor

from dbus_fast import DBusError, Variant
from dbus_fast.service import ServiceInterface, method, signal

from . import INTERFACE, __version__, jobs as jobsmod, llm
from .interpreter import Interpreter

IDLE_S = float(os.environ.get('COMMAND_HOLD_IDLE_S', '600'))
NO_TERMINAL_ERROR = 'org.griffit.CommandHold.Error.NoTerminal'
REFUSED_ERROR = 'org.griffit.CommandHold.Error.Refused'


def _opt(options, key, default):
    v = options.get(key)
    if isinstance(v, Variant):
        v = v.value
    return default if v is None else v


def to_variants(intent):
    out = {}
    for k, v in intent.items():
        if isinstance(v, bool):
            out[k] = Variant('b', v)
        elif isinstance(v, int):
            out[k] = Variant('i', v)
        elif isinstance(v, float):
            out[k] = Variant('d', v)
        elif v is None:
            continue
        else:
            out[k] = Variant('s', str(v))
    return out


class CommandHoldInterface(ServiceInterface):
    def __init__(self, loop, *, interpreter=None, runner=None, warm_up=True):
        super().__init__(INTERFACE)
        self._loop = loop
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='llm')
        self._interpreter = interpreter or Interpreter()
        self._runner = runner or jobsmod.JobRunner(self._on_job, loop=loop)
        self.exit_event = asyncio.Event()
        self.quit_requested = False
        self._idle_handle = None
        self._touch()
        if warm_up:
            # Read the weights while the user is still talking: the first open
            # request then answers in seconds instead of tens of seconds.
            self._loop.run_in_executor(self._executor, self._warm_up)

    def _warm_up(self):
        if not self._interpreter.use_llm:
            return
        from . import ollama
        if not llm.ping(self._interpreter.llm_url)[0] and ollama.bundled_binary():
            ollama.ensure(self._interpreter.llm_url)
        ok, present = llm.ping(self._interpreter.llm_url, self._interpreter.llm_model)
        if ok and present and not llm.loaded(self._interpreter.llm_url, self._interpreter.llm_model):
            llm.warm_up(self._interpreter.llm_url, self._interpreter.llm_model)

    # -- idle ---------------------------------------------------------------

    def _touch(self):
        if self._idle_handle:
            self._idle_handle.cancel()
        self._idle_handle = self._loop.call_later(IDLE_S, self._on_idle)

    def _on_idle(self):
        self._idle_handle = None
        if self._runner.active:
            self._touch()
            return
        self.exit_event.set()

    @property
    def busy(self):
        return self._runner.active

    # -- methods -------------------------------------------------------------

    @method()
    async def Interpret(self, text: 's', options: 'a{sv}') -> 'a{sv}':
        self._touch()
        self._interpreter.use_llm = bool(_opt(options, 'llm', True))
        self._interpreter.llm_model = str(_opt(options, 'llm-model', llm.DEFAULT_MODEL)) or llm.DEFAULT_MODEL
        self._interpreter.llm_url = str(_opt(options, 'llm-url', llm.DEFAULT_URL)) or llm.DEFAULT_URL
        self._interpreter.work_dir = str(_opt(options, 'work-dir', ''))
        intent = await self._loop.run_in_executor(self._executor, self._interpreter.interpret, text)
        return to_variants(intent)

    @method()
    def Run(self, command: 's', cwd: 's') -> 's':
        self._touch()
        from . import safety
        level, why = safety.classify(command)
        if level == safety.REFUSE:
            raise DBusError(REFUSED_ERROR, why)
        try:
            return self._runner.start(command, cwd)
        except RuntimeError as e:
            raise DBusError(NO_TERMINAL_ERROR, str(e))

    @method()
    def Status(self) -> 'a{sv}':
        self._touch()
        ok, model = llm.ping(self._interpreter.llm_url, self._interpreter.llm_model)
        term = jobsmod.find_terminal()
        return {
            'version': Variant('s', __version__),
            'ollama': Variant('b', ok),
            'model': Variant('b', model),
            'model_name': Variant('s', self._interpreter.llm_model),
            'terminal': Variant('s', term[0] if term else ''),
            'script': Variant('b', bool(shutil.which('script'))),
            'apps': Variant('i', len(self._interpreter._rules.index.apps)),
            'jobs': Variant('i', len(self._runner.jobs)),
        }

    @method()
    async def EnsureOllama(self) -> 'b':
        """Start the bundled Ollama (hold/ollama) when none answers."""
        self._touch()
        from . import ollama
        return await self._loop.run_in_executor(None, ollama.ensure, self._interpreter.llm_url)

    @method()
    def ReloadApps(self):
        self._touch()
        self._interpreter.reload_apps()

    @method()
    def Quit(self):
        self.quit_requested = True
        self.exit_event.set()

    # -- signals -------------------------------------------------------------

    def _on_job(self, jid, state, code, tail):
        self.Job(jid, state, code, tail)

    @signal()
    def Job(self, jid: 's', state: 's', exit_code: 'i', tail: 's') -> 'ssis':
        return [jid, state, exit_code, tail]


async def serve():
    from dbus_fast import BusType, RequestNameReply
    from dbus_fast.aio import MessageBus
    from . import BUS_NAME, OBJECT_PATH

    loop = asyncio.get_running_loop()
    iface = CommandHoldInterface(loop)
    bus = await MessageBus(bus_type=BusType.SESSION).connect()
    bus.export(OBJECT_PATH, iface)
    reply = await bus.request_name(BUS_NAME)
    if reply not in (RequestNameReply.PRIMARY_OWNER, RequestNameReply.ALREADY_OWNER):
        raise SystemExit(f'{BUS_NAME} is already running')
    gone = loop.create_task(bus.wait_for_disconnect())
    while True:
        done = loop.create_task(iface.exit_event.wait())
        await asyncio.wait({done, gone}, return_when=asyncio.FIRST_COMPLETED)
        if gone.done():
            done.cancel()
            break
        if iface.busy and not iface.quit_requested:
            iface.exit_event.clear()
            continue
        break
    gone.cancel()
    bus.disconnect()
