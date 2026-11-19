/**
 * Spike B test script (browser console / browser.evaluate).
 *
 * Paste the body of `runTravelFeedback` into the live SillyTavern tab after the
 * Neo Terra map window is open. It runs the three travel modes and returns raw
 * timings plus the shipped arrival cues (destination toast, Return pulse/static
 * badge under reduced motion, and the structured sidebar card).
 *
 * It never persists a default change: `map.closeOnTravel` is restored after
 * every run, and `map.arrivalFeedback` is only read.
 *
 * Usage (browser console):
 *   copy the function below, call `await runTravelFeedback({ mode: 'close' })`
 *   then `{ mode: 'keep-open' }` and `{ mode: 'keep-open-reopen' }`.
 */
export async function runTravelFeedback({ mode = 'close', destinationTitle = null } = {}) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const ctx = window.SillyTavern.getContext();
    const settingsRoot = ctx.extensionSettings?.neoterra;
    if (!settingsRoot?.map) {
        return { ok: false, reason: 'no Neo Terra settings' };
    }
    const original = settingsRoot.map.closeOnTravel;
    settingsRoot.map.closeOnTravel = mode !== 'close';
    ctx.saveSettingsDebounced?.();

    const readCues = (t0) => {
        const toast = document.querySelector('#neoterra-toasts [data-neoterra-toast^="travel:"]');
        const returnButton = document.querySelector('[data-neoterra-map-return]');
        const card = document.querySelector('[data-neoterra-arrival-summary]');
        return {
            t: +(performance.now() - t0).toFixed(0),
            toast: toast
                ? {
                    id: toast.dataset.neoterraToast,
                    text: toast.innerText.replace(/\n/g, ' | ').slice(0, 240),
                    hasAction: !!toast.querySelector('[data-neoterra-toast-action]'),
                }
                : null,
            pulse: returnButton?.classList?.contains('is-pulsing') === true,
            arrivalCue: returnButton?.dataset?.neoterraArrivalCue ?? null,
            reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
            card: card
                ? {
                    key: card.dataset.arrivalKey,
                    text: card.innerText.replace(/\n/g, ' | ').slice(0, 300),
                    hasIntro: !!card.querySelector('details[data-neoterra-map-intro]'),
                }
                : null,
        };
    };

    try {
        if (!document.querySelector('[data-neoterra-window="map"]')) {
            document.querySelector('[data-neoterra-hud-action="map"]')?.click();
            await sleep(1500);
        }
        const keys = [...document.querySelectorAll('[data-neoterra-map-canvas] path.neoterra-map-key')];
        let selected = null;
        for (const key of keys) {
            key.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            await sleep(50);
            const travel = document.querySelector('[data-neoterra-map-travel]');
            const title = document.querySelector('[data-neoterra-map-submenu] h4')?.textContent?.trim() ?? null;
            if (travel && travel.disabled === false && (!destinationTitle || title === destinationTitle)) {
                selected = title;
                break;
            }
        }
        if (!selected) {
            return { ok: false, reason: 'no enabled travel node' };
        }
        const beforeLen = ctx.chat.length;
        const start = performance.now();
        document.querySelector('[data-neoterra-map-travel]')?.click();
        let frameAt = null;
        let mapClosedAt = null;
        let cues = null;
        for (let i = 0; i < 700; i += 1) {
            await sleep(100);
            const live = window.SillyTavern.getContext();
            if (live.chat.length > beforeLen && frameAt === null) {
                frameAt = +(performance.now() - start).toFixed(0);
            }
            if (!document.querySelector('[data-neoterra-window="map"]') && mapClosedAt === null) {
                mapClosedAt = +(performance.now() - start).toFixed(0);
            }
            const now = readCues(start);
            if (cues === null && (now.toast || now.card)) {
                cues = now;
            }
            if (frameAt !== null && cues !== null && (mode === 'close' ? mapClosedAt !== null : true)) {
                break;
            }
        }

        let reopened = null;
        if (mode === 'keep-open-reopen') {
            const clickStart = performance.now();
            document.querySelector('[data-neoterra-map-close]')?.click();
            await sleep(300);
            document.querySelector('[data-neoterra-hud-action="map"]')?.click();
            await sleep(1500);
            reopened = {
                clicks: 1,
                ms: +(performance.now() - clickStart).toFixed(0),
                card: document.querySelector('[data-neoterra-arrival-summary]')?.dataset?.arrivalKey ?? null,
            };
        }

        const live = window.SillyTavern.getContext();
        return {
            ok: true,
            mode,
            selected,
            frameAt,
            mapClosedAt,
            cues,
            mapOpen: !!document.querySelector('[data-neoterra-window="map"]'),
            location: live.chatMetadata?.neoterra?.worldState?.scene?.locationId ?? null,
            timeSlot: live.chatMetadata?.neoterra?.worldState?.meta?.timeOfDay ?? null,
            travel: live.chatMetadata?.neoterra?.worldState?.flags?.travel ?? null,
            uiMap: live.chatMetadata?.neoterra?.ui?.map ?? null,
            reopened,
        };
    } finally {
        settingsRoot.map.closeOnTravel = original;
        ctx.saveSettingsDebounced?.();
    }
}
