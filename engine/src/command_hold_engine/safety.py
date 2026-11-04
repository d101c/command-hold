"""Guard rails for shell commands. The LLM's own `needs_confirmation` is
ignored: every command is classified here, from its text alone.

    REFUSE  never run, whatever the user confirms (destroys the system)
    CONFIRM shown with a warning before the dialog's Run
    OK      shown in the dialog like any other command

The extension always shows the command and waits for Enter: CONFIRM only
changes the wording. REFUSE is final."""
import re

REFUSE = 'refuse'
CONFIRM = 'confirm'
OK = 'ok'

_REFUSE = [
    (r'\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+|--recursive\s+)+(--no-preserve-root\s+)?["\']?(/|~|\$HOME|/home|/\*|\*)["\']?(\s|$)', 'deletes the whole system or home'),
    (r'\brm\s+-[a-zA-Z]*f[a-zA-Z]*\s+/\s*$', 'deletes /'),
    (r'\bmkfs(\.\w+)?\b', 'formats a disk'),
    (r'\bdd\b.*\bof=/dev/(sd|nvme|mmcblk|vd|hd)', 'overwrites a disk'),
    (r'>\s*/dev/(sd|nvme|mmcblk|vd|hd)', 'overwrites a disk'),
    (r'\bwipefs\b|\bshred\b.*/dev/', 'wipes a disk'),
    (r':\s*\(\s*\)\s*\{.*:\s*\|\s*:', 'fork bomb'),
    (r'\bchmod\s+(-R\s+)?[0-7]*777\s+/\s*$|\bchmod\s+-R\s+[0-7]+\s+/(\s|$)', 'opens the whole filesystem'),
    (r'\bchown\s+-R\s+\S+\s+/(\s|$)', 'changes ownership of /'),
    (r'\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b', 'pipes the network into a shell'),
    (r'\b(poweroff|halt)\b|\bshutdown\s+(-h|now)|\breboot\b|\bsystemctl\s+(poweroff|reboot|halt)\b', 'use the power action instead'),
    (r'\bdeluser\b|\buserdel\b|\bpasswd\b', 'account changes by voice are refused'),
    (r'\b(iptables|nft)\s+-F\b|\bufw\s+disable\b', 'drops the firewall'),
    (r'\bmv\s+/\s|\bmv\s+~\s', 'moves the root or home folder'),
    (r'\bhistory\s+-c\b|\bshred\b', 'destroys history'),
    (r'\b(sudo\s+)?rm\s+-rf?\s+/(etc|usr|boot|bin|sbin|lib|var|dev|proc|sys)\b', 'deletes a system directory'),
]

_CONFIRM = [
    (r'\bsudo\b|\bpkexec\b|\bdoas\b', 'runs as root'),
    (r'\brm\b', 'deletes files'),
    (r'\b(apt|apt-get|dnf|pacman|zypper|snap|flatpak|pip|pipx|npm|cargo)\s+(install|remove|purge|upgrade|update|autoremove|uninstall)\b', 'changes installed software'),
    (r'\bgit\s+(push\s+.*(-f|--force)|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--|branch\s+-D)\b', 'rewrites git history or files'),
    (r'\b(kill|pkill|killall)\b', 'ends processes'),
    (r'\bsystemctl\b.*\b(stop|disable|mask|restart|enable|start)\b', 'changes services'),
    (r'\b(chmod|chown|chgrp)\b', 'changes permissions'),
    (r'\b(mv|cp)\b.*\s-[a-z]*f', 'overwrites files'),
    (r'\bcrontab\b|\bat\b\s+\d', 'schedules something'),
    (r'\b(truncate|:>|>\s*\S)', 'overwrites a file'),
    (r'\b(dconf|gsettings)\s+(write|set|reset)\b', 'changes settings'),
    (r'\bnmcli\b.*\b(down|off|delete)\b', 'drops the network'),
    (r'\bdocker\s+(rm|rmi|system\s+prune)\b', 'removes containers or images'),
]


def classify(command):
    """Return (level, reason) for a command line."""
    c = ' '.join((command or '').split())
    if not c:
        return REFUSE, 'empty command'
    if len(c) > 1000:
        return REFUSE, 'command too long'
    if re.search(r'[\x00-\x08\x0b-\x1f]', c):
        return REFUSE, 'control characters'
    for pat, why in _REFUSE:
        if re.search(pat, c):
            return REFUSE, why
    for pat, why in _CONFIRM:
        if re.search(pat, c):
            return CONFIRM, why
    return OK, ''


# -- read-only commands ------------------------------------------------------
#
# A command that only looks something up ("how much disk is left") runs
# without a confirmation and without a terminal: the helper runs it itself
# and the pill shows its output. The list is closed: a command is read-only
# only when every piece of the pipeline is one of these programs, used in a
# way that cannot write anything.

READ_ONLY_PROGRAMS = {
    'df', 'du', 'free', 'uptime', 'ls', 'lsblk', 'lscpu', 'lsusb', 'lspci', 'lsmem', 'lsof',
    'ip', 'ss', 'nproc', 'uname', 'date', 'cal', 'whoami', 'id', 'hostname', 'pwd', 'env',
    'printenv', 'ps', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'file', 'stat',
    'which', 'type', 'echo', 'printf', 'sort', 'uniq', 'cut', 'tr', 'column', 'tree', 'numfmt',
    'tac', 'nl', 'basename', 'dirname', 'realpath', 'readlink', 'md5sum', 'sha256sum',
    'dmesg', 'journalctl', 'sensors', 'nvidia-smi', 'ping', 'dig', 'host', 'nslookup', 'acpi',
    'lsb_release', 'getent', 'locale', 'xdg-user-dir', 'last', 'w', 'who', 'vmstat', 'iostat',
    'bc', 'expr', 'seq', 'yes', 'true', 'false', 'test', 'sleep',
    'git', 'systemctl', 'nmcli', 'timedatectl', 'hostnamectl', 'loginctl', 'docker', 'podman',
    'apt', 'apt-cache', 'dpkg', 'dpkg-query', 'pip', 'pip3', 'flatpak', 'snap', 'gnome-extensions',
    'find', 'gsettings', 'dconf', 'xdg-mime', 'ollama', 'pactl', 'wpctl', 'brightnessctl',
    'python3', 'python', 'curl',
}

# Programs whose first argument decides: only these sub-commands are read-only.
_READ_ONLY_SUBCOMMANDS = {
    'git': {'status', 'log', 'diff', 'show', 'branch', 'remote', 'tag', 'stash', 'describe',
            'rev-parse', 'ls-files', 'blame', 'shortlog', 'reflog', 'config', 'worktree'},
    'systemctl': {'status', 'list-units', 'list-unit-files', 'list-timers', 'is-active',
                  'is-enabled', 'is-failed', 'show', 'cat', 'list-dependencies'},
    'nmcli': {'general', 'device', 'connection', 'radio', 'networking', 'monitor'},
    'timedatectl': {'status', 'show', 'list-timezones', 'timesync-status', ''},
    'hostnamectl': {'status', 'show', ''},
    'loginctl': {'list-sessions', 'list-users', 'show-session', 'show-user', 'session-status', 'user-status', ''},
    'docker': {'ps', 'images', 'version', 'info', 'stats', 'logs', 'inspect', 'top', 'volume', 'network', 'system'},
    'podman': {'ps', 'images', 'version', 'info', 'stats', 'logs', 'inspect', 'top', 'volume', 'network', 'system'},
    'apt': {'list', 'show', 'search', 'policy', 'depends', 'rdepends'},
    'apt-cache': {'show', 'search', 'policy', 'depends', 'rdepends', 'madison', 'stats'},
    'dpkg': {'-l', '-L', '-s', '-S', '--list', '--status', '--listfiles', '--search', '--print-architecture'},
    'dpkg-query': {'-l', '-L', '-s', '-S', '-W', '--list', '--status', '--show'},
    'pip': {'list', 'show', 'freeze', 'check', '--version'},
    'pip3': {'list', 'show', 'freeze', 'check', '--version'},
    'flatpak': {'list', 'info', 'search', 'remotes', 'history', '--version'},
    'snap': {'list', 'info', 'find', 'version', 'services'},
    'gnome-extensions': {'list', 'info', 'show', 'version'},
    'gsettings': {'get', 'list-keys', 'list-schemas', 'list-children', 'list-recursively', 'describe', 'range'},
    'dconf': {'read', 'list', 'dump'},
    'xdg-mime': {'query'},
    'ollama': {'list', 'ps', 'show', '--version'},
    'pactl': {'list', 'info', 'stat', 'get-sink-volume', 'get-source-volume', 'get-sink-mute',
              'get-source-mute', 'get-default-sink', 'get-default-source'},
    'wpctl': {'status', 'get-volume', 'inspect'},
    'brightnessctl': {'get', 'max', 'info', '-l', '--list'},
    'docker volume': {'ls', 'inspect'}, 'docker network': {'ls', 'inspect'}, 'docker system': {'df', 'info'},
    'podman volume': {'ls', 'inspect'}, 'podman network': {'ls', 'inspect'}, 'podman system': {'df', 'info'},
    'nmcli radio': {'all', 'wifi', 'wwan', ''}, 'nmcli networking': {'connectivity', ''},
    'nmcli device': {'status', 'show', 'wifi', 'monitor', ''},
    'nmcli connection': {'show', 'monitor', ''},
    'nmcli general': {'status', 'hostname', 'permissions', 'logging', ''},
}

# Words that turn a listed program into a writer: refused as read-only.
_WRITING_WORDS = {
    'find': {'-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'},
    'nmcli': {'up', 'down', 'on', 'off', 'add', 'delete', 'modify', 'edit', 'connect', 'disconnect',
              'reload', 'rescan', 'set', 'clone', 'load', 'import', 'export', 'hotspot'},
    'tail': {'-f', '-F', '--follow'}, 'journalctl': {'-f', '--follow', '--vacuum-size', '--vacuum-time', '--rotate', '--flush'},
    'git': {'-C'},   # the LLM is given cwd; -C would escape it
    'ps': set(), 'ping': {'-f'},
    'python3': set(), 'python': set(), 'curl': set(),
}

_SHELL_SYNTAX = re.compile(r'[;&<>`$]|\|\||\n')
_OPTION = re.compile(r'^-')


def _words(segment):
    import shlex
    try:
        return shlex.split(segment)
    except ValueError:
        return None


def _program_ok(words):
    if not words:
        return False
    prog = words[0]
    if prog.startswith('./') or '/' in prog and not prog.startswith('/usr/bin/'):
        return False
    prog = prog.rsplit('/', 1)[-1]
    if prog not in READ_ONLY_PROGRAMS:
        return False
    args = words[1:]
    bad = _WRITING_WORDS.get(prog, set())
    if any(a in bad or a.split('=')[0] in bad for a in args):
        return False
    if prog == 'python3' or prog == 'python':
        # Only a `-c` one-liner printing something out, no imports: arithmetic.
        return len(args) == 2 and args[0] == '-c' and 'import' not in args[1] \
            and 'open(' not in args[1] and '__' not in args[1]
    if prog == 'curl':
        # A plain GET of a text service (wttr.in, ipinfo…): no data, no output file.
        if any(a.startswith(('-d', '--data', '-F', '--form', '-o', '--output', '-O', '-T', '--upload',
                             '-X', '--request', '-K', '--config', '-u', '--user', '-H', '--header',
                             '--cookie', '-b', '-c', '--netrc', '-n')) for a in args):
            return False
        return True
    subs = _READ_ONLY_SUBCOMMANDS.get(prog)
    if subs is None:
        return True
    positional = [a for a in args if not _OPTION.match(a)]
    if prog in ('dpkg', 'dpkg-query', 'brightnessctl') or (prog == 'pip' or prog == 'pip3') and args and args[0] == '--version':
        first = args[0] if args else ''
    else:
        first = positional[0] if positional else ''
    if first not in subs:
        return False
    # Second-level sub-commands (docker volume ls, nmcli radio wifi…).
    second = _READ_ONLY_SUBCOMMANDS.get(f'{prog} {first}')
    if second is not None:
        rest = [a for a in positional[1:]]
        if (rest[0] if rest else '') not in second:
            return False
    if prog == 'git' and first == 'config' and any(not _OPTION.match(a) for a in positional[1:]) and len(positional) > 2:
        return False   # `git config key value` writes
    if prog == 'git' and first in ('branch', 'tag', 'remote', 'stash', 'worktree'):
        writers = {'-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy', '--edit-description',
                   'add', 'remove', 'rm', 'rename', 'set-url', 'prune', 'update', 'push', 'pop', 'apply',
                   'drop', 'clear', 'create', 'save', 'lock', 'unlock', 'move', 'repair', '--set-upstream-to', '-u', '--unset-upstream'}
        if any(a in writers for a in args):
            return False
        if first == 'tag' and len(positional) > 1 and '-l' not in args and '--list' not in args:
            return False   # `git tag v1` creates
    return True


def read_only(command):
    """True when the command can be run silently, with no confirmation: a
    pipeline of listed programs, no redirection, no sub-shell, no chaining."""
    c = ' '.join((command or '').split())
    if not c or len(c) > 500:
        return False
    if _SHELL_SYNTAX.search(c):
        return False
    if classify(c)[0] != OK:
        return False
    for segment in c.split('|'):
        words = _words(segment.strip())
        if not words or not _program_ok(words):
            return False
    return True
