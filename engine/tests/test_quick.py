from command_hold_engine import quick


def test_runs_and_captures_output(tmp_path):
    code, out = quick.run('echo hello; echo err >&2; exit 3', cwd=str(tmp_path))
    assert code == 3
    assert out == 'hello\nerr'


def test_runs_in_cwd_and_falls_back_to_home(tmp_path):
    (tmp_path / 'x.txt').write_text('')
    assert quick.run('ls', cwd=str(tmp_path))[1] == 'x.txt'
    code, out = quick.run('pwd', cwd='/nonexistent/dir')
    assert code == 0 and out == str(quick.Path.home())


def test_timeout_kills_the_command():
    code, out = quick.run('echo start; sleep 5', timeout=0.3)
    assert code == 124
    assert out.startswith('start') and 'stopped after 0 s' in out


def test_trim_bounds_lines_and_chars():
    out = quick.trim('\n'.join(str(i) for i in range(200)), max_lines=3)
    assert out == '0\n1\n2\n…'
    out = quick.trim('x' * 100, max_chars=10)
    assert out == 'x' * 10 + '\n…'
    assert quick.trim('a\r\nb\r') == 'a\nb'
