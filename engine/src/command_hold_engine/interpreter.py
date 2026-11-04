"""Rules first, then the local LLM, then the guard rails. Produces the intent
dict the extension executes, with a short `say` line for the pill."""
import time

from . import llm, rules, safety

CLOSED = {
    'open_app', 'close_window', 'close_all_windows', 'set_volume', 'change_volume',
    'set_brightness', 'change_brightness', 'toggle_dark_mode', 'toggle_dnd',
    'toggle_wifi', 'toggle_bluetooth', 'switch_workspace', 'screenshot', 'lock', 'power',
}


class Interpreter:
    def __init__(self, *, use_llm=True, llm_url=llm.DEFAULT_URL, llm_model=llm.DEFAULT_MODEL,
                 llm_fn=None, apps=None, work_dir=''):
        self.use_llm = use_llm
        self.llm_url = llm_url
        self.llm_model = llm_model
        self._llm_fn = llm_fn or llm.interpret
        self._rules = rules.RuleParser(apps)
        self.work_dir = work_dir

    def reload_apps(self):
        self._rules = rules.RuleParser()

    def interpret(self, text):
        t0 = time.perf_counter()
        intent = self._rules.parse(text)
        source = 'rules'
        if intent is None:
            if self.use_llm:
                try:
                    intent = self._llm_fn(text, url=self.llm_url, model=self.llm_model)
                except llm.Timeout:
                    intent = None
                    timed_out = True
                else:
                    timed_out = False
                source = 'llm'
                if intent is None:
                    intent = {'action': 'unknown', 'reason': 'llm-timeout' if timed_out else 'llm-unavailable'}
                    source = 'none'
                elif intent.get('action') == 'open_app':
                    # The model names the app; the rules know what is installed.
                    app, _ = self._rules.index.lookup(intent.get('name', ''))
                    if app:
                        intent = {'action': 'open_app', 'app_id': app['id'], 'name': app.get('name_fr') or app['name']}
                    else:
                        intent = {'action': 'unknown', 'reason': f"no app named {intent.get('name', '')!r}"}
            else:
                intent = {'action': 'unknown', 'reason': 'llm-off'}
                source = 'none'
        intent = dict(intent)
        intent['source'] = source
        intent['ms'] = round((time.perf_counter() - t0) * 1000)
        return self._finish(intent, text)

    def _finish(self, intent, text):
        action = intent.get('action', 'unknown')
        intent.setdefault('needs_confirmation', False)
        intent['refused'] = False
        if action == 'run_shell':
            cmd = ' '.join(str(intent.get('command', '')).split())
            intent['command'] = cmd
            intent.setdefault('cwd', self.work_dir)
            level, why = safety.classify(cmd)
            if level == safety.REFUSE:
                intent['refused'] = True
                intent['reason'] = why
            intent['needs_confirmation'] = True
            intent['warning'] = why if level == safety.CONFIRM else ''
        elif action == 'power':
            intent['needs_confirmation'] = True
        elif action == 'answer' and intent.get('text') == 'time':
            intent['text'] = time.strftime('%H:%M')
        elif action not in CLOSED and action not in ('answer', 'unknown'):
            intent['action'] = 'unknown'
            intent['reason'] = f'unsupported action {action!r}'
        intent['transcript'] = text
        return intent
