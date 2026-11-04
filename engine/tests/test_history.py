import json

from command_hold_engine.history import History


def test_add_note_last(tmp_path):
    h = History(tmp_path / 'h.jsonl')
    a = h.add('ouvre firefox', 'open_app', say='Firefox')
    b = h.add('place disque', 'run_shell', command='df -h ~')
    assert h.note(b, 'Filesystem…', 0)
    assert not h.note('nope', 'x')
    last = h.last(5)
    assert [e['id'] for e in last] == [b, a]
    assert last[0]['result'] == 'Filesystem…' and last[0]['exit'] == 0
    assert last[1]['say'] == 'Firefox' and last[1]['exit'] is None
    assert h.last(1)[0]['id'] == b and h.last(0) == []
    # Reloaded from disk by a fresh instance.
    again = History(tmp_path / 'h.jsonl')
    assert [e['id'] for e in again.last(5)] == [b, a]


def test_bounded_and_tolerant(tmp_path):
    p = tmp_path / 'h.jsonl'
    p.write_text('garbage\n' + json.dumps({'id': 'old', 'transcript': 'x'}) + '\n')
    h = History(p, max_entries=3)
    for i in range(5):
        h.add(f't{i}', 'answer')
    assert [e['transcript'] for e in h.last(10)] == ['t4', 't3', 't2']
    h.clear()
    assert h.last(5) == [] and History(p).last(5) == []


def test_result_is_capped(tmp_path):
    h = History(tmp_path / 'h.jsonl')
    i = h.add('t', 'run_shell')
    h.note(i, 'x' * 10000)
    assert len(h.last(1)[0]['result']) == 6000
