// Wrap `IBus.InputContext.prototype.process_key_event_async` so that a key
// typed into a text field can be swallowed before the application sees it.
//
// Why patch a prototype at all: in hands-free (tap) mode the user must be
// able to cancel with Escape while a text field has the focus. Keys typed
// into such a field never reach a Shell keybinding; the only place GNOME
// Shell sees them is this IBus call made by `Main.inputMethod` (same trick
// as Accent Hold's press-and-hold). Nothing else is patched and the wrapper
// only ever acts on Escape while a dictation is running.
//
// Several extensions may wrap the same method (Accent Hold does). The rules
// that keep every order of enable/disable safe:
//   - the wrapper calls the function it found at install time, captured in a
//     closure (never a field that gets cleared later);
//   - uninstall restores the original only if the prototype still holds our
//     wrapper; otherwise someone wrapped after us and we leave the chain
//     alone, our wrapper simply becomes a pass-through.
//
// Pure JavaScript, so it can be tested on a fake prototype with plain gjs.

// Stand-in for the GAsyncResult of a key we swallowed.
const CONSUMED = {};

// `filter(keyval, state)` returns true to swallow the key. Returns an object
// with `uninstall()`.
export function installKeyHook(proto, filter) {
    const origProcess = proto.process_key_event_async;
    const origFinish = proto.process_key_event_async_finish;
    let active = true;

    const process = function (...args) {
        const callback = args[args.length - 1];
        if (active && typeof callback === 'function' && safeFilter(filter, args[0], args[2])) {
            callback(this, CONSUMED);
            return undefined;
        }
        return origProcess.apply(this, args);
    };
    const finish = function (res) {
        if (res === CONSUMED)
            return true;
        return origFinish.call(this, res);
    };
    proto.process_key_event_async = process;
    proto.process_key_event_async_finish = finish;

    return {
        uninstall() {
            active = false;
            if (proto.process_key_event_async === process)
                proto.process_key_event_async = origProcess;
            if (proto.process_key_event_async_finish === finish)
                proto.process_key_event_async_finish = origFinish;
        },
    };
}

function safeFilter(filter, keyval, state) {
    try {
        return filter(keyval, state) === true;
    } catch (e) {
        logError(e, 'command-hold: key filter');
        return false;
    }
}
