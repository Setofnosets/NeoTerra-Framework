/**
 * Spike B test script (browser console / browser.evaluate).
 *
 * Paste the body of `runTravelFeedback` into the live SillyTavern tab after the
 * Neo Terra map window is open. It runs the three travel modes and returns raw
 * timings. It never persists a default change: `map.closeOnTravel` is restored
 * after every run.
 *
 * Usage (browser console):
 *   copy the function below, call `await runTravelFeedback({ mode: 'close' })`
 *   then `{ mode: 'keep-open' }` and `{ mode: 'keep-open-toast' }`.
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
        let toastAt = null;
        let frameText = null;
        for (let i = 0; i < 350; i += 1) {
            await sleep(100);
            const live = window.SillyTavern.getContext();
            if (live.chat.length > beforeLen && frameAt === null) {
                frameAt = performance.now() - start;
                frameText = live.chat[live.chat.length - 1]?.mes?.slice(0, 240) ?? null;
                if (mode === 'keep-open-toast') {
                    // Prototype only. Production mode needs a real arrival toast.
                    const toast = document.createElement('div');
                    toast.className = 'neoterra-toast neoterra-spike-toast';
                    toast.innerHTML = `<span class="neoterra-toast-title">Arrival</span><span class="neoterra-toast-message">You arrived at ${selected}.</span>`;
                    (document.getElementById('neoterra-toasts') ?? document.body).append(toast);
                    document.querySelector('[data-neoterra-map-return]')?.style?.setProperty('box-shadow', '0 0 0 3px rgba(94,234,212,0.55)');
                    toastAt = performance.now() - start;
                }
            }
            if (!document.querySelector('[data-neoterra-window="map"]') && mapClosedAt === null) {
                mapClosedAt = performance.now() - start;
            }
            if (frameAt !== null && (mapClosedAt !== null || mode !== 'close')) {
                break;
            }
        }
        const live = window.SillyTavern.getContext();
        return {
            ok: true,
            mode,
            selected,
            frameAt,
            mapClosedAt,
            toastAt,
            mapOpen: !!document.querySelector('[data-neoterra-window="map"]'),
            location: live.chatMetadata?.neoterra?.worldState?.scene?.locationId ?? null,
            frameText,
        };
    } finally {
        settingsRoot.map.closeOnTravel = original;
        ctx.saveSettingsDebounced?.();
        document.querySelector('.neoterra-spike-toast')?.remove();
        const ret = document.querySelector('[data-neoterra-map-return]');
        ret?.style?.removeProperty?.('box-shadow');
    }
}
