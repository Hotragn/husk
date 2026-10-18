import { beforeEach, describe, expect, it } from 'vitest';
import { linkedHandoffId, readViewerToken, storeViewerToken } from './viewerToken';

describe('viewer authentication', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('takes the token out of the URL and keeps it only for this tab session', () => {
    window.localStorage.setItem('husk.console.token', 'old-persistent-token');
    window.history.replaceState(null, '', '/?view=workspace#token=secret%2Btoken');
    expect(readViewerToken()).toEqual({ token: 'secret+token', fromLink: true });
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?view=workspace');
    expect(window.sessionStorage.getItem('husk.console.token')).toBe('secret+token');
    expect(window.localStorage.getItem('husk.console.token')).toBeNull();
    expect(readViewerToken()).toEqual({ token: 'secret+token', fromLink: false });
  });

  it('does not mistake a panel fragment for credentials and can clear a session', () => {
    window.location.hash = '#/files';
    storeViewerToken('session-token');
    expect(readViewerToken().token).toBe('session-token');
    expect(window.location.hash).toBe('#/files');
    storeViewerToken('');
    expect(readViewerToken().token).toBe('');
  });

  it('moves a handoff key out of the address bar and keeps only the handoff id', () => {
    window.history.replaceState(null, '', '/#handoff=hnd_1&token=abc123');
    expect(readViewerToken()).toEqual({ token: 'abc123', fromLink: true });
    expect(window.location.hash).toBe('#handoff=hnd_1');
    expect(window.location.href).not.toContain('abc123');
    expect(linkedHandoffId()).toBe('hnd_1');
  });
});
