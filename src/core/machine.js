/**
 * A tiny explicit state machine for the map (and later for travel/scene
 * flows). Dependency-free and DOM-free, so it is testable in Node.
 *
 *   const flow = createMachine({
 *       name: 'map',
 *       initial: 'closed',
 *       states: {
 *           closed: { on: { OPEN: 'open' } },
 *           open:   { on: { SELECT: 'location', CLOSE: 'closed' } },
 *           location: { on: { OPEN_TRAVEL: 'travel', CLOSE: 'closed' } },
 *           travel: { on: { CONFIRM_TRAVEL: 'open', CANCEL: 'location' } },
 *       },
 *   });
 *   flow.send('OPEN');
 *
 * Contract:
 * - `on[EVENT]` is a target state name, or `{ target, guard, action }`.
 *   `guard(context, payload)` may refuse the event.
 * - `exit` runs before the state changes, `enter` after; both receive
 *   `(context, otherState, payload)`.
 * - A transition to the same state runs exit and enter again unless it is
 *   written `{ target, internal: true }`.
 * - `*` in `on` catches any event the state does not list.
 * - An event nobody accepts is ignored and reported through `onIgnored`, so a
 *   stray click can never leave the session half-transitioned.
 */
export function createMachine({
    name = 'machine',
    initial,
    states,
    context = {},
    onChange = () => {},
    onIgnored = () => {},
} = {}) {
    if (!states || !Object.hasOwn(states, initial)) {
        throw new Error(`${name}: unknown initial state ${String(initial)}`);
    }
    for (const [state, definition] of Object.entries(states)) {
        for (const [event, rule] of Object.entries(definition?.on ?? {})) {
            const target = typeof rule === 'string' ? rule : rule?.target;
            if (!target || !Object.hasOwn(states, target)) {
                throw new Error(`${name}: ${state}.${event} goes to unknown state ${String(target)}`);
            }
        }
    }

    let current = initial;
    let running = false;
    const queue = [];

    function transition(event, payload) {
        const definition = states[current];
        const rule = definition?.on?.[event] ?? definition?.on?.['*'];
        if (rule == null) {
            onIgnored(event, current, payload);
            return false;
        }
        const spec = typeof rule === 'string' ? { target: rule } : rule;
        if (spec.guard && !spec.guard(context, payload)) {
            onIgnored(event, current, payload);
            return false;
        }
        const from = current;
        const to = spec.target;
        if (spec.internal && from === to) {
            spec.action?.(context, payload);
            return true;
        }
        definition?.exit?.(context, to, payload);
        current = to;
        spec.action?.(context, payload);
        states[to]?.enter?.(context, from, payload);
        onChange(to, from, event, payload);
        return true;
    }

    return {
        get state() {
            return current;
        },
        get name() {
            return name;
        },
        context,
        is: (...names) => names.includes(current),
        /**
         * Whether the current state declares an `on` entry for `event`.
         * Note: this is structural only — a guard can still refuse the event.
         */
        can: (event) => Boolean(states[current]?.on?.[event] ?? states[current]?.on?.['*']),
        /**
         * Send an event. Events sent while a transition's own hooks are
         * running wait their turn, so hooks never observe a half-made state.
         * Returns true when the event moved (or stayed in) a state.
         */
        send(event, payload) {
            if (running) {
                queue.push([event, payload]);
                return true;
            }
            running = true;
            let ok;
            try {
                ok = transition(event, payload);
                while (queue.length > 0) {
                    transition(...queue.shift());
                }
            } finally {
                running = false;
                queue.length = 0;
            }
            return ok;
        },
        reset() {
            const from = current;
            current = initial;
            onChange(initial, from, 'RESET', undefined);
        },
    };
}
