/**
 * Browser download helper. Kept in its own module so settings and the Director
 * card setup share one implementation without importing each other.
 */

export function downloadJson(filename, payload) {
    if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
        return false;
    }
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    return true;
}
