import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

// Before any shell command (or power action) runs, the user sees exactly
// what will run and confirms with Enter, or cancels with Escape.
// Resolves to true (run) or false.

export function confirm({title, command, warning, runLabel, cancelLabel}) {
    return new Promise(resolve => {
        let decided = false;
        const dialog = new ModalDialog.ModalDialog({styleClass: 'command-hold-dialog'});
        const box = new St.BoxLayout({vertical: true, style_class: 'command-hold-dialog-content'});
        box.add_child(new St.Label({text: title, style_class: 'command-hold-dialog-title'}));
        const cmd = new St.Label({text: command, style_class: 'command-hold-dialog-command'});
        cmd.clutter_text.line_wrap = true;
        cmd.clutter_text.line_wrap_mode = 2; // Pango.WrapMode.WORD_CHAR
        box.add_child(cmd);
        if (warning)
            box.add_child(new St.Label({text: warning, style_class: 'command-hold-dialog-warning'}));
        dialog.contentLayout.add_child(box);

        const finish = ok => {
            if (decided)
                return;
            decided = true;
            dialog.close();
            resolve(ok);
        };
        dialog.setButtons([
            {label: cancelLabel, action: () => finish(false), key: Clutter.KEY_Escape},
            {label: runLabel, action: () => finish(true), default: true},
        ]);
        dialog.connect('closed', () => finish(false));
        if (!dialog.open())
            finish(false);
    });
}
