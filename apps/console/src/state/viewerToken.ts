const TOKEN_KEY = 'husk.console.token';

/** A fragment stays out of HTTP requests; remove it before rendering or navigating. */
export function readViewerToken(): { token: string; fromLink: boolean } {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const linked = fragment.get('token');
  if (linked !== null) {
    storeViewerToken(linked);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    return { token: linked, fromLink: true };
  }
  try {
    return { token: window.sessionStorage.getItem(TOKEN_KEY) ?? '', fromLink: false };
  } catch {
    return { token: '', fromLink: false };
  }
}

export function storeViewerToken(token: string): void {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
    // Previous releases persisted credentials across browser sessions.
    window.localStorage.removeItem(TOKEN_KEY);
  } catch { /* The in-memory connection remains usable when storage is unavailable. */ }
}
