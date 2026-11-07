/**
 * Husk answers, and this tab is not signed in to it: a console opened from a
 * plain address, or one Husk restarted under, with a new token.
 *
 * The way in is a sign-in link from `husk console`, whose code works once. The
 * box below takes the code from such a link, or the server's token itself.
 */

import { useState } from 'react';
import { Button, CopyCommand, ErrorBlock, Field } from '../components/primitives';
import { useConnection } from '../state/connection';

export function SignInScreen() {
  const { signIn, signInError } = useConnection();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <main id="main" className="app-main disconnected" style={{ paddingTop: 'var(--space-16)' }}>
      <h1>Sign in to this Husk</h1>
      <p>Husk is running on this machine, and this tab is not signed in to it. A sign-in link opens it in one click.</p>

      <div className="row-gap-4">
        <div>
          <h2>Get a sign-in link</h2>
          <div style={{ marginTop: 'var(--space-3)' }}>
            <CopyCommand command="husk console" />
          </div>
          <p className="hint">
            Run it in a terminal on this machine, and open the link it prints. Each link works once, within 10
            minutes. The Husk app opens the console signed in by itself.
          </p>
        </div>

        {signInError ? <ErrorBlock error={{ code: 'E_NO_CREDENTIALS', message: signInError }} /> : null}

        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void signIn(draft).finally(() => setBusy(false));
          }}
        >
          <Field label="Or paste a sign-in code" htmlFor="signin-code" note="The part of a sign-in link after #code=. This server's token works too.">
            <input
              id="signin-code"
              className="input mono"
              type="password"
              autoComplete="off"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </Field>
          <div className="field">
            <span className="field-label" aria-hidden="true">
              &nbsp;
            </span>
            <Button type="submit" variant="primary" loading={busy} disabled={!draft.trim()}>
              Sign in
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}
