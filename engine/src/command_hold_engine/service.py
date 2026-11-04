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

from . import INTERFACE, __version__, jobs as jobsmod, llm, quick, safety
from .history import History
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
    def __init__(self, loop, *, interpreter=None, runner=None, warm_up=True, history=None):
        super().__init__(INTERFACE)
        self._loop = loop
        self._history = history or History()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='llm')
        self._interpreter = interpreter or Interpreter()
        self._runner = runner or jobsmod.JobRunner(self._on_job, loop=loop)
        self.exit_event = asyncio.Event()
        self.quit_requested = False
        self._idle_handle = None
        self._touch()
        self._warming = False
        self._primed = False
        if warm_up:
            # Read the weights while the user is still talking: the first open
            # request then answers in seconds instead of tens of seconds.
            self._loop.run_in_executor(self._executor, self._warm_up)

    def _warm_up(self):
        if not self._interpreter.use_llm or self._warming:
            return
        self._warming = True
        try:
            from . import ollama
            if not llm.ping(self._interpreter.llm_url)[0] and ollama.bundled_binary():
                ollama.ensure(self._interpreter.llm_url)
            ok, present = llm.ping(self._interpreter.llm_url, self._interpreter.llm_model)
            if not ok or not present:
                return
            # A loaded model may still have an empty prompt cache (loaded by
            # someone else, or unloaded and reloaded by Ollama): prime it once
            # per load.
            if self._primed and llm.loaded(self._interpreter.llm_url, self._interpreter.llm_model):
                return
            self._primed = llm.warm_up(self._interpreter.llm_url, self._interpreter.llm_model)
        finally:
            self._warming = False

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
        intent['id'] = self._history.add(text, intent.get('action', 'unknown'),
                                         command=str(intent.get('command', '')),
                                         say=str(intent.get('text', '')), source=str(intent.get('source', '')))
        return to_variants(intent)

    @method()
    async def RunQuiet(self, id: 's', command: 's', cwd: 's') -> '(is)':
        """Run a read-only command here and return (exit code, output). The
        command is checked again: only the closed list runs this way."""
        self._touch()
        if not safety.read_only(command):
            raise DBusError(REFUSED_ERROR, 'not a read-only command')
        code, out = await self._loop.run_in_executor(None, quick.run, command, cwd)
        self._history.note(id, out, code)
        return [code, out]

    @method()
    async def Summarize(self, transcript: 's', command: 's', output: 's') -> 's':
        """One spoken sentence about a command's output (for the voice), from
        the local LLM. '' when the LLM is off or has nothing."""
        self._touch()
        if not self._interpreter.use_llm:
            return ''
        it = self._interpreter
        return await self._loop.run_in_executor(
            self._executor, lambda: llm.summarize(transcript, command, output, url=it.llm_url, model=it.llm_model))

    @method()
    def Note(self, id: 's', result: 's', exit_code: 'i'):
        """Attach the outcome the pill showed to a history entry (-1: no exit code)."""
        self._touch()
        self._history.note(id, result, None if exit_code < 0 else exit_code)

    @method()
    def History(self, n: 'i') -> 's':
        """The last n requests, newest first, as a JSON array."""
        self._touch()
        import json
        return json.dumps(self._history.last(n), ensure_ascii=False)

    @method()
    def Run(self, command: 's', cwd: 's') -> 's':
        self._touch()
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
    def Prepare(self):
        """Load the model and prime the prompt cache in the background, while
        the user is still talking. Returns at once."""
        self._touch()
        self._loop.run_in_executor(self._executor, self._warm_up)

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
