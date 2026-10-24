const TOKEN_KEY = 'husk.console.token';

/** A fragment stays out of HTTP requests; remove it before rendering or navigating. */
export function readViewerToken(): { token: string; fromLink: boolean } {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const linked = fragment.get('token');
  if (linked !== null) {
    storeViewerToken(linked);
    // A handoff or computer link keeps its (non-secret) id so the app knows what to open.
    const handoff = fragment.get('handoff');
    const computer = fragment.get('computer');
    // The desktop app opens the console on a panel: `#token=...&panel=connect`.
    const panel = fragment.get('panel');
    const keep = handoff
      ? `#handoff=${encodeURIComponent(handoff)}`
      : computer
        ? `#computer=${encodeURIComponent(computer)}`
        : panel && /^[a-z]{1,20}$/.test(panel)
          ? `#/${panel}`
          : '';
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${keep}`);
    return { token: linked, fromLink: true };
  }
  try {
    return { token: window.sessionStorage.getItem(TOKEN_KEY) ?? '', fromLink: false };
  } catch {
    return { token: '', fromLink: false };
  }
}

/** The handoff a handoff link opened, if this tab came from one. */
export function linkedHandoffId(): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get('handoff');
}

/** The computer a computer link (from a chat's card) opened, if this tab came from one. */
export function linkedComputerId(): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get('computer');
}

export function storeViewerToken(token: string): void {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
    // Previous releases persisted credentials across browser sessions.
    window.localStorage.removeItem(TOKEN_KEY);
  } catch { /* The in-memory connection remains usable when storage is unavailable. */ }
}
