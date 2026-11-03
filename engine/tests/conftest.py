import pytest

# A fixed set of "installed" applications so the tests do not depend on the
# machine they run on.
FAKE_APPS = [
    {'id': 'firefox_firefox.desktop', 'name': 'Firefox', 'name_fr': '', 'generic': 'Web Browser', 'generic_fr': 'Navigateur Web', 'keywords': ['Internet', 'WWW', 'Browser'], 'exec': 'firefox'},
    {'id': 'org.gnome.Ptyxis.desktop', 'name': 'Ptyxis', 'name_fr': '', 'generic': 'Terminal', 'generic_fr': 'Terminal', 'keywords': ['shell', 'prompt', 'command', 'commandline', 'cmd', 'terminal'], 'exec': 'ptyxis'},
    {'id': 'org.gnome.Settings.desktop', 'name': 'Settings', 'name_fr': 'Paramètres', 'generic': 'Settings', 'generic_fr': 'Paramètres', 'keywords': ['Preferences', 'Settings'], 'exec': 'gnome-control-center'},
    {'id': 'code_code.desktop', 'name': 'Visual Studio Code', 'name_fr': '', 'generic': 'Text Editor', 'generic_fr': '', 'keywords': ['vscode'], 'exec': 'code'},
    {'id': 'org.gnome.Nautilus.desktop', 'name': 'Files', 'name_fr': 'Fichiers', 'generic': 'File Manager', 'generic_fr': 'Gestionnaire de fichiers', 'keywords': ['folder', 'manager', 'explore', 'disk', 'filesystem'], 'exec': 'nautilus'},
    {'id': 'spotify_spotify.desktop', 'name': 'Spotify', 'name_fr': '', 'generic': 'Music', 'generic_fr': '', 'keywords': [], 'exec': 'spotify'},
    {'id': 'org.gnome.Calculator.desktop', 'name': 'Calculator', 'name_fr': 'Calculatrice', 'generic': 'Calculator', 'generic_fr': 'Calculatrice', 'keywords': ['calculation', 'arithmetic'], 'exec': 'gnome-calculator'},
    {'id': 'google-chrome.desktop', 'name': 'Google Chrome', 'name_fr': '', 'generic': 'Web Browser', 'generic_fr': '', 'keywords': [], 'exec': 'google-chrome'},
    {'id': 'org.gnome.TextEditor.desktop', 'name': 'Text Editor', 'name_fr': 'Éditeur de texte', 'generic': 'Text Editor', 'generic_fr': '', 'keywords': ['write', 'notes'], 'exec': 'gnome-text-editor'},
    {'id': 'thunderbird.desktop', 'name': 'Thunderbird', 'name_fr': '', 'generic': 'Mail Client', 'generic_fr': 'Client de messagerie', 'keywords': ['Email', 'E-mail'], 'exec': 'thunderbird'},
]


@pytest.fixture
def fake_apps():
    return FAKE_APPS
