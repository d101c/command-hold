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
