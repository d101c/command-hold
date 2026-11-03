// Run: gjs -m extension/tests/keyHook.test.js
//
// Two extensions wrapping the same prototype method (Accent Hold and Voice
// Hold) in every enable/disable order. The "other" extension is simulated
// both the safe way (guarded restore, like ours) and the naive way
// (unconditional restore, Accent Hold 2.0): neither order may leave a dead
// wrapper in the chain or a throwing method.
import {installKeyHook} from '../keyHook.js';

let failures = 0;
function test(name, fn) {
    try {
        fn();
        print(`PASS ${name}`);
    } catch (e) {
        failures++;
        print(`FAIL ${name}: ${e.message}`);
    }
}
function check(cond, msg) {
    if (!cond)
        throw new Error(msg);
}

const ESC = 0xff1b;
const RELEASE = 1 << 30;

// A fake IBus.InputContext prototype: the original async call records what
// it got and answers through the callback with a token the finish function
// understands.
function makeProto() {
    const calls = [];
    const ORIG = {orig: true};
    const proto = {
        process_key_event_async(keyval, keycode, state, cancellable, callback) {
            calls.push(keyval);
            callback(this, ORIG);
        },
        process_key_event_async_finish(res) {
            if (res === ORIG)
                return false;        // "not handled by the input method"
            throw new Error(`unknown result ${JSON.stringify(res)}`);
        },
    };
    return {proto, calls};
}

// Type a key through the prototype as GNOME Shell would; returns the value
// of the finish function (true = swallowed).
function press(proto, keyval, state = 0) {
    let out;
    proto.process_key_event_async(keyval, 0, state, null, (ctx, res) => {
        out = proto.process_key_event_async_finish.call(ctx, res);
    });
    return out;
}

// The naive wrapper another extension might install: restores
// unconditionally and reads its original through a field cleared on disable.
function installNaive(proto, filter) {
    const self = {orig: proto.process_key_event_async, origFinish: proto.process_key_event_async_finish};
    const CONSUMED = {};
    proto.process_key_event_async = function (...args) {
        const cb = args[args.length - 1];
        if (filter(args[0])) {
            cb(this, CONSUMED);
            return undefined;
        }
        return self.orig.apply(this, args);
    };
    proto.process_key_event_async_finish = function (res) {
        if (res === CONSUMED)
            return true;
        return self.origFinish.call(this, res);
    };
    return {
        uninstall() {
            proto.process_key_event_async = self.orig;
            proto.process_key_event_async_finish = self.origFinish;
            self.orig = null;
            self.origFinish = null;
        },
    };
}

test('alone: Escape swallowed while active, everything restored after', () => {
    const {proto, calls} = makeProto();
    const orig = proto.process_key_event_async;
    let active = true;
    const hook = installKeyHook(proto, k => active && k === ESC);
    check(press(proto, ESC) === true, 'escape swallowed');
    check(press(proto, 0x61) === false, 'a goes through');
    check(calls.join() === '97', 'only a reached the original');
    active = false;
    check(press(proto, ESC) === false, 'escape goes through when idle');
    hook.uninstall();
    check(proto.process_key_event_async === orig, 'original restored');
    check(press(proto, ESC) === false, 'works after uninstall');
});

test('filter errors are logged, not propagated', () => {
    const {proto} = makeProto();
    const hook = installKeyHook(proto, () => { throw new Error('boom'); });
    check(press(proto, ESC) === false, 'falls through');
    hook.uninstall();
});

for (const [label, installOther] of [['guarded other', installKeyHook], ['naive other', installNaive]]) {
    test(`${label}: other-enable, us-enable, other-disable, us-disable`, () => {
        const {proto, calls} = makeProto();
        const orig = proto.process_key_event_async;
        const other = installOther(proto, k => k === 0x62);     // the other one eats 'b'
        const us = installKeyHook(proto, k => k === ESC);
        check(press(proto, ESC) === true, 'ours works');
        check(press(proto, 0x62) === true, 'theirs works');
        other.uninstall();
        // Ours may or may not still be in the chain depending on the other's
        // behaviour; in no case may a key throw.
        check(press(proto, 0x62) === false, 'b goes through after their disable');
        check(press(proto, 0x61) === false, 'a goes through');
        us.uninstall();
        // A guarded other leaves its (inert) wrapper under ours, so the chain
        // can only unwind fully in reverse order; a naive other restored the
        // original itself. Either way every key must reach the original.
        if (installOther === installNaive)
            check(proto.process_key_event_async === orig, 'prototype back to the original');
        calls.length = 0;
        check(press(proto, ESC) === false, 'escape goes through at the end');
        check(press(proto, 0x61) === false, 'a goes through at the end');
        check(calls.join() === `${ESC},97`, 'both keys reached the original');
    });

    test(`${label}: us-enable, other-enable, us-disable, other-disable`, () => {
        const {proto} = makeProto();
        const orig = proto.process_key_event_async;
        const us = installKeyHook(proto, k => k === ESC);
        const other = installOther(proto, k => k === 0x62);
        us.uninstall();
        // We were wrapped by the other: we must leave the chain alone and be
        // a pass-through from now on.
        check(proto.process_key_event_async !== orig, 'chain left in place');
        check(press(proto, ESC) === false, 'our wrapper is inert');
        check(press(proto, 0x62) === true, 'theirs still works');
        other.uninstall();
        check(press(proto, ESC) === false, 'no throw at the end');
        check(press(proto, 0x61) === false, 'a goes through at the end');
    });

    test(`${label}: us-enable, other-enable, other-disable, us-disable`, () => {
        const {proto} = makeProto();
        const orig = proto.process_key_event_async;
        const us = installKeyHook(proto, k => k === ESC);
        const other = installOther(proto, k => k === 0x62);
        other.uninstall();
        check(press(proto, ESC) === true, 'ours still works');
        us.uninstall();
        check(proto.process_key_event_async === orig, 'prototype back to the original');
        check(press(proto, ESC) === false, 'escape goes through at the end');
    });
}

test('release events are passed to the filter with their state', () => {
    const {proto} = makeProto();
    const seen = [];
    const hook = installKeyHook(proto, (k, s) => { seen.push([k, s]); return k === ESC; });
    press(proto, ESC, RELEASE);
    check(seen.length === 1 && seen[0][1] === RELEASE, 'state forwarded');
    hook.uninstall();
});

print(failures ? `${failures} failure(s)` : 'all passed');
if (failures)
    imports.system.exit(1);
