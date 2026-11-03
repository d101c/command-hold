import io
import json

from command_hold_engine import llm
from command_hold_engine.interpreter import Interpreter


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def opener_returning(content):
    calls = []

    def opener(req, timeout=None):
        calls.append(json.loads(req.data.decode()))
        body = {'message': {'role': 'assistant', 'content': content}}
        return FakeResponse(json.dumps(body).encode())
    opener.calls = calls
    return opener


def test_interpret_sends_schema_and_parses():
    op = opener_returning('{"action":"run_shell","command":"df -h ~","needs_confirmation":false}')
    out = llm.interpret('combien de place sur le disque', opener=op, timeout=5)
    assert out == {'action': 'run_shell', 'command': 'df -h ~', 'needs_confirmation': False}
    sent = op.calls[0]
    assert sent['format'] == llm.SCHEMA and sent['think'] is False and sent['stream'] is False
    assert sent['messages'][0]['content'] == llm.SYSTEM
    assert sent['options']['num_thread'] == 4


def test_parse_tolerates_fences_and_prose():
    assert llm.parse('```json\n{"action":"lock"}\n```') == {'action': 'lock'}
    assert llm.parse('Sure! {"action":"unknown"} there you go') == {'action': 'unknown'}
    assert llm.parse('{"action":"fly"}') is None
    assert llm.parse('not json') is None
    assert llm.parse(None) is None


def test_unreachable_gives_none():
    def opener(req, timeout=None):
        raise OSError('connection refused')
    assert llm.interpret('x', opener=opener) is None


def test_ping_reports_model():
    def opener(req, timeout=None):
        return FakeResponse(json.dumps({'models': [{'name': 'qwen3:1.7b'}]}).encode())
    assert llm.ping(opener=opener) == (True, True)
    assert llm.ping(model='gemma3:1b', opener=opener) == (True, False)


def test_interpreter_falls_back_and_guards(fake_apps):
    seen = []

    def fake_llm(text, url, model):
        seen.append(text)
        return {'action': 'run_shell', 'command': 'rm -rf /', 'needs_confirmation': False}
    it = Interpreter(apps=fake_apps, llm_fn=fake_llm)
    out = it.interpret('optimise mon ordinateur')
    assert seen == ['optimise mon ordinateur']
    assert out['action'] == 'run_shell' and out['refused'] and out['needs_confirmation']
    assert out['source'] == 'llm'
    # rules decide without the LLM
    out = it.interpret('ouvre firefox')
    assert out['source'] == 'rules' and out['app_id'] == 'firefox_firefox.desktop' and seen == ['optimise mon ordinateur']


def test_interpreter_llm_off_and_unavailable(fake_apps):
    it = Interpreter(apps=fake_apps, use_llm=False)
    assert it.interpret('optimise mon ordinateur')['reason'] == 'llm-off'
    it = Interpreter(apps=fake_apps, llm_fn=lambda *a, **k: None)
    assert it.interpret('optimise mon ordinateur')['reason'] == 'llm-unavailable'


def test_interpreter_maps_llm_app_names_to_installed(fake_apps):
    it = Interpreter(apps=fake_apps, llm_fn=lambda *a, **k: {'action': 'open_app', 'name': 'chrome'})
    out = it.interpret('je veux naviguer avec chrome')
    assert out['app_id'] == 'google-chrome.desktop'
    it = Interpreter(apps=fake_apps, llm_fn=lambda *a, **k: {'action': 'open_app', 'name': 'photoshop'})
    assert it.interpret('je veux photoshop')['action'] == 'unknown'


def test_cold_timeout_when_model_not_loaded():
    seen = []

    def opener(req, timeout=None):
        seen.append((req.full_url.rsplit('/', 1)[-1], timeout))
        if req.full_url.endswith('/api/ps'):
            return FakeResponse(json.dumps({'models': []}).encode())
        return FakeResponse(json.dumps({'message': {'content': '{"action":"lock"}'}}).encode())
    assert llm.interpret('verrouille', opener=opener) == {'action': 'lock'}
    assert seen[0][0] == 'ps' and seen[1] == ('chat', llm.COLD_TIMEOUT_S)


def test_warm_timeout_when_loaded():
    seen = []

    def opener(req, timeout=None):
        seen.append((req.full_url.rsplit('/', 1)[-1], timeout))
        if req.full_url.endswith('/api/ps'):
            return FakeResponse(json.dumps({'models': [{'name': 'qwen3:1.7b'}]}).encode())
        return FakeResponse(json.dumps({'message': {'content': '{"action":"lock"}'}}).encode())
    llm.interpret('verrouille', opener=opener)
    assert seen[1] == ('chat', llm.TIMEOUT_S)
    assert llm.loaded(opener=opener) is True
