# Command Hold

Maintenez une touche et dites quoi faire. Commandes vocales hors-ligne pour GNOME Shell.

Troisième membre de la famille Hold, après [Accent Hold](https://github.com/d101c/accent-hold)
(accents par appui long) et [Voice Hold](https://github.com/d101c/voice-hold)
(dictée « appuie et parle »).

- **Maintenez `Super+C`** et parlez, relâchez : « ouvre Firefox », « volume à
  la moitié », « mode sombre », « bureau suivant », « verrouille l'écran »,
  « capture d'écran », « coupe le wifi », « ferme toutes les fenêtres »…
  s'exécutent aussitôt.
- Tout le reste (« clone le dépôt d101c slash voice hold dans développement »,
  « mets à jour le système », « qu'est-ce qui prend ma mémoire ») devient une
  commande shell que vous **voyez et confirmez** (Entrée) avant qu'elle ne
  tourne dans un terminal visible. La pastille dit ensuite *En cours…*,
  *Terminé ✓* ou *Échec ✗ (code N)* avec les dernières lignes. `sudo` marche :
  c'est un vrai terminal.
- Un **appui bref** garde l'écoute mains libres jusqu'au prochain appui, à
  Échap ou à quelques secondes de silence.
- Français, anglais (et les 23 autres langues du moteur Voice Hold).
- 100 % local : rien ne quitte votre ordinateur.

## Comment ça comprend

1. **Des règles** (< 1 ms) : expressions régulières tolérantes au bruit de
   dictée, nombres en lettres, rapprochement flou avec les applications
   réellement installées. Elles couvrent toutes les actions GNOME et quelques
   gabarits shell sûrs.
2. **Un petit LLM local** (optionnel, 2 à 4 s sur un portable sans GPU) via
   [Ollama](https://ollama.com), modèle `qwen3:1.7b` par défaut, seulement pour
   ce que les règles laissent : commandes shell et questions. Sa sortie est
   contrainte à un schéma JSON et jamais crue pour la sécurité.
3. **Des garde-fous**, calculés par le helper à partir du texte de la commande
   seul : liste noire qui refuse net (`rm -rf /`, `mkfs`, `dd` vers un disque,
   fork bomb, réseau redirigé dans un shell, comptes…), liste grise qui ajoute un
   avertissement (`sudo`, `rm`, gestionnaires de paquets, `git push --force`,
   `kill`…). Chaque commande est affichée avant de tourner ; le LLM ne voit
   jamais la sortie des commandes.

Mesuré sur un i7-8565U (4 cœurs, pas de GPU) : une action GNOME tombe ≈ 0,6 s
après la fin de la phrase ; une commande shell est proposée ≈ 3 s après ;
mémoire ≈ 2,9 Go avec le modèle vocal et le LLM chargés, rendue après inactivité.

## Installation

Trois morceaux, tous locaux.

1. **Moteur Voice Hold** (reconnaissance vocale, partagé avec l'extension Voice Hold) :
   ```
   pipx install "git+https://github.com/d101c/voice-hold#subdirectory=engine" && voice-hold-engine setup
   ```
2. **Moteur de commandes** (ce dépôt, `engine/`) :
   ```
   pipx install "git+https://github.com/d101c/command-hold#subdirectory=engine" && command-hold-engine install-service
   ```
3. **Ollama et le modèle** (optionnel, pour les demandes ouvertes) :
   ```
   curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen3:1.7b
   ```
4. L'extension : depuis extensions.gnome.org une fois publiée, ou le zip de la
   dernière release (`gnome-extensions install --force command-hold@griffit.gmail.com.shell-extension.zip`),
   puis déconnexion/reconnexion et activation.

`command-hold-engine status` vérifie tout ; `command-hold-engine interpret
"ouvre firefox"` montre ce qu'une phrase ferait, sans le faire ;
`command-hold-engine apps` liste les applications connues des règles.

Nécessite GNOME Shell 45–50 sous Wayland, PipeWire, Python ≥ 3.12 et un
terminal (Ptyxis, Console ou GNOME Terminal).

## Réglages

Raccourci (modificateur obligatoire), mode de geste, seuil d'appui, délai de
silence, micro (les entrées du moteur Voice Hold, défaut système par défaut),
LLM on/off, modèle, URL d'Ollama, dossier de travail des commandes, pastille
(îlot qui sort de sous la barre supérieure, ou à côté du curseur) et
indicateur. Le menu de la barre bascule le raccourci et le LLM et
montre l'état du moteur sans le démarrer.

## Sécurité

Le helper écoute sur le bus de session sans authentification, comme tout
service de session : n'importe quel processus tournant sous votre compte peut
l'appeler. Il ne lance que ce que l'extension a affiché et que vous avez
confirmé ; les commandes refusées le sont quel que soit l'appelant. Les
commandes lancées sont journalisées dans `~/.local/state/command-hold/history.log`.
Luminosité : écran interne seulement. Super seul ne peut pas servir de
raccourci (c'est la touche d'aperçu de Mutter).

## Licences

Extension et helper : GPL-2.0-or-later. dbus-fast MIT ; Ollama MIT ; poids
Qwen3 Apache-2.0, téléchargés par vous. La reconnaissance vocale vient du
moteur Voice Hold (sherpa-onnx Apache-2.0, Parakeet TDT 0.6B v3 CC-BY-4.0,
Silero VAD MIT).

J'ai utilisé une assistance IA (Claude) pour écrire et relire ce code ; chaque
ligne est à moi à expliquer.
