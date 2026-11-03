"""The rules alone on the study test set (closed actions must all pass; the
open ones are the LLM's job) and on dictation noise."""
import json
import re
import unicodedata
from pathlib import Path

import pytest

from command_hold_engine.interpreter import Interpreter
from command_hold_engine.rules import AppIndex, RuleParser

ITEMS = json.loads((Path(__file__).parent / 'data' / 'testset.json').read_text())['items']
OPEN = {'run_shell', 'answer'}


def norm(s):
    s = unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode()
    return re.sub(r'\s+', ' ', s.lower()).strip()


def matches(exp, pred):
    if pred.get('action') != exp['action']:
        return False
    if 'name_any' in exp:
        n = norm(pred.get('name'))
        if not n or not any(a == n or a in n or n in a for a in map(norm, exp['name_any'])):
            return False
    if 'percent' in exp and pred.get('percent') != exp['percent']:
        return False
    if 'delta_sign' in exp:
        d = pred.get('delta') or 0
        if d == 0 or (d > 0) != (exp['delta_sign'] == '+'):
            return False
    if 'enable' in exp and exp['enable'] is not None and pred.get('enable') != exp['enable']:
        return False
    if 'n' in exp:
        n = pred.get('n')
        if isinstance(exp['n'], int):
            if n != exp['n']:
                return False
        elif norm(n) != exp['n']:
            return False
    if 'target_any' in exp and norm(pred.get('target')) not in exp['target_any']:
        return False
    if 'power_action' in exp and norm(pred.get('power_action')) != exp['power_action']:
        return False
    cmd = norm(pred.get('command'))
    if 'command_keywords' in exp and not all(k in cmd for k in map(norm, exp['command_keywords'])):
        return False
    if 'command_keywords_any' in exp and not any(k in cmd for k in map(norm, exp['command_keywords_any'])):
        return False
    return True


@pytest.mark.parametrize('item', ITEMS, ids=[f"{i['id']}-{i['text'][:30]}" for i in ITEMS])
def test_study_item(item, fake_apps):
    it = Interpreter(use_llm=False, apps=fake_apps)
    pred = it.interpret(item['text'])
    expectations = [item['expect']] + item.get('accept', [])
    ok = any(matches(e, pred) for e in expectations)
    if item['expect']['action'] in OPEN and not ok:
        # Open requests may legitimately be left to the LLM by the rules.
        assert pred['action'] == 'unknown', pred
        return
    assert ok, pred


def test_closed_items_never_need_the_llm(fake_apps):
    p = RuleParser(fake_apps)
    for item in ITEMS:
        if item['expect']['action'] not in OPEN and item['expect']['action'] != 'unknown':
            assert p.parse(item['text']) is not None, item['text']


@pytest.mark.parametrize('text,action,extra', [
    ('euh ouvre moi fire fox', 'open_app', {'app_id': 'firefox_firefox.desktop'}),
    ('ouvre un terminal', 'open_app', {'app_id': 'org.gnome.Ptyxis.desktop'}),
    ('lance moi la calculatrice', 'open_app', {'app_id': 'org.gnome.Calculator.desktop'}),
    ('open the file manager', 'open_app', {'app_id': 'org.gnome.Nautilus.desktop'}),
    ('ouvre mes mails', 'open_app', {'app_id': 'thunderbird.desktop'}),
    ('monte un peu le son', 'change_volume', {'delta': 10}),
    ('baisse le volume s il te plait', 'change_volume', {'delta': -10}),
    ('volume à quarante pour cent', 'set_volume', {'percent': 40}),
    ('coupe le son', 'set_volume', {'percent': 0}),
    ('mets la luminosité au maximum', 'set_brightness', {'percent': 100}),
    ('turn off bluetooth', 'toggle_bluetooth', {'enable': False}),
    ('active le mode sombre', 'toggle_dark_mode', {'enable': True}),
    ('passe en clair', 'toggle_dark_mode', {'enable': False}),
    ('coupe les notifications', 'toggle_dnd', {'enable': True}),
    ('remets les notifications', 'toggle_dnd', {'enable': False}),
    ('va sur le bureau trois', 'switch_workspace', {'n': 3}),
    ('workspace suivant', 'switch_workspace', {'n': 'next'}),
    ('ferme cette fenêtre', 'close_window', {}),
    ('verrouille l écran', 'lock', {}),
    ('éteins l ordinateur', 'power', {'power_action': 'shutdown'}),
    ('éteins l écran', 'unknown', {}),
    ('clone le dépôt github d101c slash voice hold dans développement', 'run_shell', {'command': 'git clone https://github.com/d101c/voice-hold ~/DEVELOPEMENT'}),
    ('merci', 'unknown', {}),
])
def test_noise(text, action, extra, fake_apps):
    it = Interpreter(use_llm=False, apps=fake_apps)
    pred = it.interpret(text)
    assert pred['action'] == action, pred
    for k, v in extra.items():
        assert pred.get(k) == v, pred


def test_app_lookup_prefers_exact_then_prefix_then_fuzzy(fake_apps):
    idx = AppIndex(fake_apps)
    assert idx.lookup('firefox')[0]['id'] == 'firefox_firefox.desktop'
    assert idx.lookup('fire fox')[0]['id'] == 'firefox_firefox.desktop'
    assert idx.lookup('visual studio')[0]['id'] == 'code_code.desktop'
    assert idx.lookup('spotifie')[0]['id'] == 'spotify_spotify.desktop'
    assert idx.lookup('photoshop')[0] is None


def test_rules_are_fast(fake_apps):
    import time
    p = RuleParser(fake_apps)
    t0 = time.perf_counter()
    for _ in range(200):
        p.parse('euh mets le volume à la moitié s il te plaît')
    assert (time.perf_counter() - t0) / 200 < 0.005
