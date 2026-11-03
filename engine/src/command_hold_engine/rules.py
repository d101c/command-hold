"""Rule-based intent parser: regular expressions tolerant to dictation
noise, number words, and fuzzy matching of spoken application names against
the applications actually installed. Sub-millisecond; it decides first and
the LLM only sees what it leaves as `unknown`."""
import re
import unicodedata

from . import apps as appsmod

NUM_WORDS = {
    'zero': 0, 'deux': 2, 'two': 2, 'trois': 3, 'three': 3,
    'quatre': 4, 'four': 4, 'cinq': 5, 'five': 5, 'six': 6, 'sept': 7, 'seven': 7, 'huit': 8,
    'eight': 8, 'neuf': 9, 'nine': 9, 'dix': 10, 'ten': 10, 'vingt': 20, 'twenty': 20,
    'trente': 30, 'thirty': 30, 'quarante': 40, 'forty': 40, 'cinquante': 50, 'fifty': 50,
    'soixante': 60, 'sixty': 60, 'soixante-dix': 70, 'seventy': 70, 'quatre-vingts': 80,
    'quatre-vingt': 80, 'eighty': 80, 'quatre-vingt-dix': 90, 'ninety': 90, 'cent': 100,
    'hundred': 100, 'premier': 1, 'premiere': 1, 'first': 1, 'deuxieme': 2, 'second': 2,
    'seconde': 2, 'troisieme': 3, 'third': 3, 'quatrieme': 4, 'fourth': 4, 'cinquieme': 5,
    'fifth': 5,
}
FILLERS = r"\b(euh+|hum+|hmm+|bah|ben|alors|donc|moi|me|s'il te plait|s'il vous plait|please|stp|svp|tu sais|la|tu peux|peux tu|can you|could you|est ce que)\b"

# spoken name -> what the .desktop files call it
ALIASES = {
    'terminal': ['ptyxis', 'console', 'terminal', 'gnome-terminal'],
    'console': ['ptyxis', 'console', 'terminal'],
    'settings': ['settings', 'parametres'], 'parametres': ['settings', 'parametres'],
    'reglages': ['settings', 'parametres'], 'preferences': ['settings'],
    'fichiers': ['files', 'fichiers', 'nautilus'], 'files': ['files', 'nautilus'],
    'explorateur': ['files', 'fichiers'], 'gestionnaire de fichiers': ['files', 'fichiers'],
    'file manager': ['files'], 'calculatrice': ['calculator'],
    'chrome': ['google chrome', 'chromium', 'chrome'],
    'code': ['visual studio code'], 'vscode': ['visual studio code'], 'vs code': ['visual studio code'],
    'navigateur': ['firefox'], 'browser': ['firefox'], 'web': ['firefox'],
    'mail': ['thunderbird', 'geary', 'evolution'], 'mails': ['thunderbird', 'geary', 'evolution'],
    'musique': ['spotify', 'rhythmbox', 'music'], 'music': ['spotify', 'rhythmbox', 'music'],
    'editeur': ['text editor', 'editeur de texte'], 'text editor': ['text editor'],
    'calendrier': ['calendar'], 'agenda': ['calendar'], 'horloge': ['clocks'], 'clock': ['clocks'],
    'photos': ['loupe', 'image viewer', 'photos'], 'images': ['loupe', 'image viewer'],
}


def norm(s):
    s = unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode()
    return re.sub(r'\s+', ' ', s.lower()).strip()


def levenshtein(a, b):
    if a == b:
        return 0
    if not a or not b:
        return max(len(a), len(b))
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


class AppIndex:
    """Fuzzy lookup of a spoken application name among installed apps."""

    def __init__(self, apps=None):
        self.apps = apps if apps is not None else appsmod.list_apps()
        self.keys = []  # (normalised key without spaces, app, weight)
        for a in self.apps:
            primary = {a.get('name'), a.get('name_fr'), a.get('exec')}
            secondary = {a.get('generic'), a.get('generic_fr')} | set(a.get('keywords', []))
            for n in primary:
                if n:
                    self.keys.append((norm(n).replace(' ', ''), a, 1.0))
            for n in secondary - primary:
                if n:
                    self.keys.append((norm(n).replace(' ', ''), a, 0.95))

    def lookup(self, spoken):
        """Return (app, score) or (None, best score)."""
        sp = norm(spoken)
        q = sp.replace(' ', '')
        if not q:
            return None, 0.0
        cands = [q] + [norm(x).replace(' ', '') for x in ALIASES.get(sp, [])]
        best, best_s = None, 0.0
        for k, app, weight in self.keys:
            for c in cands:
                if c == k:
                    s = 1.0
                elif len(c) >= 4 and (k.startswith(c) or c in k):
                    s = 0.9 * len(c) / len(k) + 0.1
                else:
                    s = 1 - levenshtein(c, k) / max(len(c), len(k))
                s *= weight
                if s > best_s:
                    best, best_s = app, s
        return (best, best_s) if best_s >= 0.6 else (None, best_s)


class RuleParser:
    def __init__(self, apps=None):
        self.index = AppIndex(apps)

    @staticmethod
    def _number(t):
        m = re.search(r'\b(\d{1,3})\b', t)
        if m:
            return int(m.group(1))
        for w, v in sorted(NUM_WORDS.items(), key=lambda kv: -len(kv[0])):
            if re.search(rf'\b{re.escape(w)}\b', t):
                return v
        return None

    def parse(self, text):
        """Return an intent dict, or None when the rules do not conclude."""
        t = norm(text)
        t = re.sub(FILLERS, ' ', t)
        t = re.sub(r"[.,;!?]+", ' ', t)
        t = t.replace("'", ' ')
        t = re.sub(r'\s+', ' ', t).strip()
        if not t:
            return {'action': 'unknown', 'reason': 'empty'}
        num = self._number(t)
        has_pct = bool(re.search(r'\bpour ?cent\b|%|\bpercent\b', t))

        if re.search(r"\b(quelle heure|what time)\b", t):
            return {'action': 'answer', 'text': 'time'}
        # Questions about how things work go to the LLM, not to an action.
        if re.search(r"^(comment|c est quoi|how do i|how to|what is|what s|pourquoi|why|est ce qu)\b", t):
            return None
        # lock / power
        if re.search(r'\b(verrouill\w*|lock)\b', t) and not re.search(r'\bunlock|deverrouill', t):
            return {'action': 'lock'}
        if re.search(r'\b(redemarre?r?|reboot|restart)\b', t) and not re.search(r'\b(service|serveur|server|ollama|docker|pipewire|gnome)\b', t):
            return {'action': 'power', 'power_action': 'reboot', 'needs_confirmation': True}
        if re.search(r"\b(eteins?|eteindre|shut ?down|power off|poweroff)\b", t) and not re.search(r'\b(ecran|screen|wifi|bluetooth|son|volume|lumiere|light)\b', t):
            return {'action': 'power', 'power_action': 'shutdown', 'needs_confirmation': True}
        if re.search(r'\b(mets? en veille|mise en veille|suspend|sleep)\b', t):
            return {'action': 'power', 'power_action': 'suspend', 'needs_confirmation': True}
        if re.search(r'\b(deconnecte|log ?out|ferme la session)\b', t):
            return {'action': 'power', 'power_action': 'logout', 'needs_confirmation': True}
        # windows
        if re.search(r'\b(ferme|close|quitte)\b.*\b(toutes? les? fenetres?|all (the )?windows|everything|tout)\b', t):
            return {'action': 'close_all_windows'}
        if re.search(r'\b(ferme|close)\b.*\b(fenetre|window|ca|this|cette appli)\b', t):
            return {'action': 'close_window'}
        # screenshot
        if re.search(r'\b(capture|screenshot|screen shot|photo de l ecran)\b', t):
            if re.search(r'\b(fenetre|window)\b', t):
                return {'action': 'screenshot', 'target': 'window'}
            if re.search(r'\b(zone|area|region|selection|partie)\b', t):
                return {'action': 'screenshot', 'target': 'area'}
            return {'action': 'screenshot', 'target': 'screen'}
        # workspaces
        if re.search(r'\b(espace de travail|workspace|bureau)\b', t):
            if re.search(r'\b(suivant|next|droite|right)\b', t):
                return {'action': 'switch_workspace', 'n': 'next'}
            if re.search(r'\b(precedent|previous|prev|gauche|left)\b', t):
                return {'action': 'switch_workspace', 'n': 'prev'}
            if num is not None:
                return {'action': 'switch_workspace', 'n': num}
            return {'action': 'unknown', 'reason': 'which workspace'}
        # toggles
        off = bool(re.search(r"\b(desactive|eteins?|coupe|off|disable|turn off|enleve|stoppe?|arrete)\b", t))
        if re.search(r'\b(mode sombre|theme sombre|dark mode|dark theme|sombre|dark)\b', t):
            return {'action': 'toggle_dark_mode', 'enable': not off}
        if re.search(r'\b(mode clair|theme clair|light mode|light theme|clair)\b', t):
            return {'action': 'toggle_dark_mode', 'enable': False}
        if re.search(r'\b(ne pas deranger|do not disturb|dnd|notifications?)\b', t):
            if re.search(r'notification', t):
                back = bool(re.search(r'\b(reactive|remets?|re-?enable|back|rallume|reactiver)\b', t))
                return {'action': 'toggle_dnd', 'enable': (off and not back)}
            return {'action': 'toggle_dnd', 'enable': not off}
        if re.search(r'\b(wifi|wi-fi|wireless)\b', t):
            return {'action': 'toggle_wifi', 'enable': not off}
        if re.search(r'\b(bluetooth)\b', t):
            return {'action': 'toggle_bluetooth', 'enable': not off}
        # volume / brightness
        if re.search(r'\b(volume|son|sound|audio|mute|muet|silence)\b', t):
            if re.search(r'\b(coupe|mute|muet|silence|eteins)\b', t):
                return {'action': 'set_volume', 'percent': 0}
            if re.search(r'\b(moitie|half)\b', t):
                return {'action': 'set_volume', 'percent': 50}
            if re.search(r'\b(max|maximum|fond|a fond)\b', t):
                return {'action': 'set_volume', 'percent': 100}
            if re.search(r'\b(monte|augmente|plus fort|up|louder|raise|increase)\b', t) and not (num is not None and (has_pct or re.search(r'\b(a|to|at)\b \d', t))):
                return {'action': 'change_volume', 'delta': 10}
            if re.search(r'\b(baisse|diminue|moins fort|down|lower|decrease|quieter)\b', t) and not (num is not None and (has_pct or re.search(r'\b(a|to|at)\b \d', t))):
                return {'action': 'change_volume', 'delta': -10}
            if num is not None:
                return {'action': 'set_volume', 'percent': max(0, min(100, num))}
            if re.search(r'\b(remets?|unmute|rallume|back)\b', t):
                return {'action': 'set_volume', 'percent': 50}
            return {'action': 'unknown', 'reason': 'which volume'}
        if re.search(r'\b(luminosite|brightness|brighter|darker|dimmer|ecran plus)\b', t):
            if re.search(r'\b(max|maximum|a fond)\b', t):
                return {'action': 'set_brightness', 'percent': 100}
            if re.search(r'\b(min|minimum)\b', t):
                return {'action': 'set_brightness', 'percent': 10}
            if num is not None:
                return {'action': 'set_brightness', 'percent': max(0, min(100, num))}
            if re.search(r'\b(monte|augmente|brighter|up|raise|increase|plus)\b', t):
                return {'action': 'change_brightness', 'delta': 10}
            if re.search(r'\b(baisse|diminue|darker|dimmer|down|lower|decrease|moins)\b', t):
                return {'action': 'change_brightness', 'delta': -10}
            return {'action': 'unknown', 'reason': 'which brightness'}
        # open an application
        m = re.search(r"\b(ouvre|ouvrir|lance|lancer|demarre|open|launch|start|run)\b\s*(?:moi|me|les|le|la|l'|the|une|un|a|l)?\s*(.+)$", t)
        if m:
            spoken = m.group(2).strip()
            spoken = re.sub(r'\b(et|and|puis|then)\b.*$', '', spoken).strip()
            if re.search(r'\b(git|apt|ping|status|commande|command)\b', t) and 'terminal' in spoken:
                pass  # "open a terminal and run git status": shell
            elif spoken:
                app, s = self.index.lookup(spoken)
                if app:
                    return {'action': 'open_app', 'app_id': app['id'], 'name': app.get('name_fr') or app['name']}
                return None  # let the LLM try (it may be a command)
        # a few safe shell templates
        if re.search(r'\bgit status\b', t):
            return {'action': 'run_shell', 'command': 'git status'}
        m = re.search(r'\bclone\b.*?\b(?:depot|repo|repository)?\s*(?:github)?\s*([a-z0-9_.-]+)\s+slash\s+(.+?)(?:\s+(?:dans|in|into)\s+(.+))?$', t)
        if m:
            owner, repo, dest = m.group(1), m.group(2).strip().replace(' ', '-'), m.group(3)
            d = ' ~/DEVELOPEMENT' if dest and 'develop' in dest else (f' ~/{dest.replace(" ", "-")}' if dest else '')
            return {'action': 'run_shell', 'command': f'git clone https://github.com/{owner}/{repo}{d}'}
        if re.search(r'\b(place|espace)\b.*\bdisque\b|\bdisk space\b|\bespace disque\b', t) and not re.search(r'\b(libere|free up|nettoie)\b', t):
            return {'action': 'run_shell', 'command': 'df -h ~'}
        if re.search(r'\b(memoire|memory|ram)\b', t) and not re.search(r'\b(libere|free up|nettoie)\b', t):
            return {'action': 'run_shell', 'command': 'free -h && ps aux --sort=-%mem | head -n 10'}
        if re.search(r'\b(mets? a jour|update|upgrade)\b.*\b(systeme|system|ubuntu|paquets|packages|ordinateur|computer)\b', t):
            return {'action': 'run_shell', 'command': 'sudo apt update && sudo apt upgrade'}
        if re.search(r'\b(libere|free up|nettoie|clean up)\b', t):
            return {'action': 'run_shell', 'command': 'sudo apt autoremove && sudo apt clean && journalctl --vacuum-size=200M && df -h ~'}
        if re.search(r'\b(version)\b.*\b(ubuntu|systeme|os|gnome)\b', t):
            return {'action': 'run_shell', 'command': 'lsb_release -a && gnome-shell --version'}
        if re.search(r'\b(adresse ip|ip address|mon ip)\b', t):
            return {'action': 'run_shell', 'command': 'ip -brief address'}
        m = re.search(r'\bping\b.*?\b([a-z0-9.-]+)\s*(?:point|dot)\s*([a-z]{2,4})\b', t)
        if m:
            return {'action': 'run_shell', 'command': f'ping -c 4 {m.group(1)}.{m.group(2)}'}
        m = re.search(r'\b(installe|install)\b\s+(?:le|la|les|the|moi)?\s*([a-z0-9._+-]+)\s*$', t)
        if m:
            return {'action': 'run_shell', 'command': f'sudo apt install {m.group(2)}'}
        if re.search(r'\b(biggest|largest|plus gros|plus grands|plus volumineux)\b.*\b(files?|fichiers?)\b', t):
            return {'action': 'run_shell', 'command': 'du -ah ~ 2>/dev/null | sort -rh | head -n 10'}
        if re.search(r'\b(kill|tue|termine)\b', t):
            m = re.search(r'\b(kill|tue|termine)\b.*?\b(every|all|tous|toutes|les)?\s*([a-z0-9-]+)\s*(process|processus)', t)
            if m:
                return {'action': 'run_shell', 'command': f'pkill -f {m.group(3)}'}
            return {'action': 'unknown', 'reason': 'which process'}
        if re.search(r'\b(supprime|delete|remove|efface|rm)\b', t) and not re.search(r'\b(fichier|file|dossier|folder|directory|repertoire)\b.*\b[a-z0-9_./-]{3,}\b', t):
            return {'action': 'unknown', 'reason': 'destructive request without an exact target'}
        if re.search(r'^(merci|thanks|thank you|ok|okay|d accord|non rien|laisse tomber|never mind|annule|cancel|rien|nothing)\b', t) and len(t.split()) <= 4:
            return {'action': 'unknown', 'reason': 'nothing to do'}
        return None
