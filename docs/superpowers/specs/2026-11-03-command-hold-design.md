# Command Hold — design (3 novembre 2026)

Troisième membre de la famille « Hold » (Accent Hold, Voice Hold) : on maintient
une touche, on parle, l'ordinateur agit. 100 % local, rien ne sort de la machine.

## Intention

- Piloter GNOME à la voix : ouvrir une application, régler volume et luminosité,
  mode sombre, ne pas déranger, espaces de travail, capture, verrouillage,
  wifi/bluetooth, fermer des fenêtres, veille/redémarrage (avec confirmation).
- Lancer des commandes shell en langage naturel (« clone le dépôt d101c slash
  voice hold », « mets à jour le système »), dans un terminal visible, avec un
  suivi (en cours / terminé / échec) dans la pastille.
- Même geste que Voice Hold : maintenir `<Super>c`, parler, relâcher. Appui bref
  = mains libres jusqu'au silence. Même pastille sombre.

Fondé sur l'étude `~/DEVELOPEMENT/voice-command-study/RAPPORT.md` (3/11/2026) :
hybride règles + LLM local, Super+C plutôt que Super seul, latences mesurées.

## Architecture

```
GNOME Shell ── extension command-hold@griffit.gmail.com (GJS)
   │  Start/Stop/Cancel, Final, Stopped…          Interpret(text), Run(cmd), Job
   ▼                                                ▼
org.griffit.VoiceHold (moteur Voice Hold, ASR)   org.griffit.CommandHold (helper Python)
                                                    ├─ règles (regex + applis installées)
                                                    ├─ LLM local : Ollama qwen3:1.7b (ouvert)
                                                    ├─ garde-fous (liste noire / grise)
                                                    └─ jobs : terminal visible + suivi
```

- L'**extension** orchestre : geste → écoute via le moteur Voice Hold (D-Bus,
  signaux `Final`) → transcription complète → `Interpret` → exécution. Les
  actions GNOME s'exécutent dans l'extension (Gio.AppInfo, Gvc, gsettings,
  NM, GnomeBluetooth, workspace manager, Shell.Screenshot, ScreenShield,
  SystemActions). Aucun processus lancé par l'extension.
- Le **helper** `command-hold-engine` (Python ≥ 3.12, dbus-fast, service
  activable) comprend le texte et exécute les commandes shell. Il ne touche
  jamais au shell GNOME.
- La reconnaissance vocale est **partagée** avec Voice Hold : un seul modèle
  chargé (1,1 Go), pas de second moteur.

## Compréhension (hybride)

1. **Règles** (`rules.py`, < 1 ms) : regex fr/en tolérantes aux hésitations,
   extraction de nombres (chiffres et mots), fuzzy Levenshtein sur les noms,
   noms localisés, mots-clés et exécutables des applications installées
   (`apps.py`, fichiers .desktop, cache 60 s). Couvre toutes les actions fermées
   et quelques gabarits shell sûrs (git status, df, free, clone owner/repo…).
2. **LLM** (`llm.py`) seulement si les règles ne concluent pas : Ollama
   `/api/chat`, modèle `qwen3:1.7b`, `think:false`, `format` = schéma JSON,
   `num_thread 4`, `keep_alive 30m`, prompt système long et constant (cache de
   préfixe), timeout 8 s. Sans Ollama : les actions fermées marchent, le reste
   répond « LLM indisponible ».
3. **Garde-fous** (`safety.py`) recalculés par le helper, jamais délégués au
   LLM : liste noire (refus : `rm -rf /`, `mkfs`, `dd of=/dev/sd…`, fork bomb,
   `chmod -R 777 /`, `curl … | sh`, `:(){…}`, `> /dev/sda`…) ; liste grise
   (`sudo`, `apt`, `rm`, `kill`, `git push --force`, `systemctl`…) ; toute
   commande shell passe de toute façon par le dialogue de confirmation.

## Schéma d'actions (`Interpret` → `a{sv}`)

`action` ∈ open_app{app_id,name} · close_window · close_all_windows ·
set_volume{percent} · change_volume{delta} · set_brightness{percent} ·
change_brightness{delta} · toggle_dark_mode{enable} · toggle_dnd{enable} ·
toggle_wifi{enable} · toggle_bluetooth{enable} · switch_workspace{n} ·
screenshot{target} · lock · power{power_action} · run_shell{command,cwd} ·
answer{text} · unknown{reason}. Plus `say` (texte court pour la pastille),
`needs_confirmation`, `refused` + `reason`, `source` ∈ rules|llm|none.

## Protocole D-Bus `org.griffit.CommandHold` `/org/griffit/CommandHold`

- `Interpret(s text) → a{sv}` (asynchrone, ≤ 10 s).
- `Run(s command, s cwd) → s job_id` : écrit `$XDG_RUNTIME_DIR/command-hold/<id>.sh`,
  ouvre un terminal (ptyxis, gnome-terminal, kgx, xdg-terminal-exec) qui exécute
  la commande sous `script` (pty conservé : couleurs, sudo), journal dans
  `<id>.log`, code de sortie dans `<id>.exit`, terminal laissé ouvert
  (« [exit N] Entrée pour fermer »). Le helper surveille `<id>.exit`.
- `Status → a{sv}` : version, ollama (b), model (b), voice_hold (b), terminal (s).
- `Quit`.
- Signal `Job(s id, s state, i exit_code, s tail)` : running → done | failed.
- Idle : le helper quitte après 10 min sans appel.

## Extension

- `commander.js` : sessions (texte accumulé, fenêtre focalisée au départ),
  machine `holdMachine.js` (copie de Voice Hold), sondage du modificateur,
  silence en mains libres, Escape via `keyHook.js`, surveillance `g-name-owner`
  des deux services, pastille (`hud.js`, copie) : gris respirant au démarrage,
  bleu à l'écoute, texte reconnu, puis le résultat.
- `actions.js` : exécution des actions GNOME, chaque action renvoie une phrase
  pour la pastille.
- `confirmDialog.js` : `ModalDialog` sombre affichant la commande ; Entrée
  lance, Échap annule.
- `voice.js` / `engine.js` : proxies D-Bus des deux services.
- Prefs : statut des trois dépendances avec commandes copiables, raccourci
  (modificateur obligatoire), mode, seuil d'appui, silence, LLM on/off,
  modèle, URL, dossier de travail, pastille, indicateur.

## Sécurité

Bus de session sans authentification (comme Voice Hold) : tout processus de
l'utilisateur peut appeler `Run` ; même niveau de privilège que l'utilisateur.
Le helper ne lance que ce que l'extension a fait confirmer ; le LLM ne voit
jamais la sortie des commandes ; `sudo` ne fonctionne que dans le terminal
visible. Journal des commandes lancées dans `$XDG_STATE_HOME/command-hold/history.log`.

## Tests

- pytest : règles sur les 65 énoncés de l'étude + énoncés supplémentaires,
  garde-fous, parsing LLM (urlopen simulé), jobs sur un faux terminal,
  interface D-Bus sur un bus privé.
- gjs : `holdMachine`, `keyHook`, `dispatch` (intention → appels d'actions sur
  un faux objet).
- Session réelle : l'utilisateur, après reconnexion.

## Limites connues

- Super seul n'est pas utilisable (overlay-key de Mutter) : Super+C.
- Luminosité : écran interne seulement.
- Les règles sont réglées sur un jeu de 65 phrases ; à élargir avec de vraies
  transcriptions.
- Le suivi d'un job dépend du terminal gardant le script ouvert ; si
  l'utilisateur ferme le terminal avant la fin, le job est signalé « échec ».
