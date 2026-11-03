import subprocess
import sys

from command_hold_engine import cli


def test_service_file_uses_the_running_interpreter(tmp_path, monkeypatch):
    monkeypatch.setenv('XDG_DATA_HOME', str(tmp_path))
    path = cli.install_service(log=lambda s: None)
    text = path.read_text()
    assert text == f'[D-BUS Service]\nName=org.griffit.CommandHold\nExec={sys.executable} -m command_hold_engine serve\n'
    interpreter = cli.service_exec().split(' -m ')[0]
    out = subprocess.run([interpreter, '-c', 'import command_hold_engine'], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr


def test_interpret_cli_prints_json(capsys):
    assert cli.main(['interpret', '--no-llm', 'verrouille', 'l', 'écran']) == 0
    assert '"action": "lock"' in capsys.readouterr().out
