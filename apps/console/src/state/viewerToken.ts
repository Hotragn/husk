const TOKEN_KEY = 'husk.console.token';

/** A fragment stays out of HTTP requests; remove it before rendering or navigating. */
export function readViewerToken(): { token: string; fromLink: boolean } {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const linked = fragment.get('token');
  if (linked !== null) {
    storeViewerToken(linked);
    storeOwnerSession(fragment.get('owner') ?? '');
    // A handoff or computer link keeps its (non-secret) id so the app knows what to open.
    const handoff = fragment.get('handoff');
    const computer = fragment.get('computer');
    // The desktop app opens the console on a panel: `#token=...&panel=connect`,
    // or as one of its own small windows: `#token=...&view=computers`.
    const panel = fragment.get('panel');
    const desk = desktopView();
    const keep = handoff
      ? `#handoff=${encodeURIComponent(handoff)}`
      : computer
        ? `#computer=${encodeURIComponent(computer)}`
        : desk
          ? `#view=${desk.view}`
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

/** One of the desktop app's own windows: the Computers window, the corner row, or the notch. */
export type DesktopView = { view: 'computers' } | { view: 'dock' } | { view: 'pill' };

/** The desktop window this page is, if the desktop app opened it as one. */
export function desktopView(): DesktopView | null {
  const view = new URLSearchParams(window.location.hash.slice(1)).get('view');
  return view === 'computers' || view === 'dock' || view === 'pill' ? { view } : null;
}

/** The computer a computer link (from a chat's card) opened, if this tab came from one. */
export function linkedComputerId(): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get('computer');
}

const OWNER_KEY = 'husk.console.owner';

/**
 * The owner session a link under remote access's public URL brought: its
 * passkey page (`/oauth/link`) adds it to the fragment, and the server needs it
 * there besides the link's own token. Kept for this tab only, never in the URL.
 */
export function ownerSession(): string {
  try {
    return window.sessionStorage.getItem(OWNER_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeOwnerSession(session: string): void {
  try {
    if (session) window.sessionStorage.setItem(OWNER_KEY, session);
    else window.sessionStorage.removeItem(OWNER_KEY);
  } catch { /* Without storage, a reload asks for the passkey again. */ }
}

export function storeViewerToken(token: string): void {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
    // Previous releases persisted credentials across browser sessions.
    window.localStorage.removeItem(TOKEN_KEY);
  } catch { /* The in-memory connection remains usable when storage is unavailable. */ }
}
