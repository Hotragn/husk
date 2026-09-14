/**
 * The screen for the normal case where the daemon is not running.
 *
 * This is not an error state bolted onto a dashboard — it replaces the
 * dashboard. There is no skeleton behind it, because a skeleton implies data is
 * on its way, and nothing is on its way until someone starts the server.
 */

import { useConnection } from '../state/connection';
import { Button, CopyCommand, ErrorBlock, Field } from '../components/primitives';
import { useState } from 'react';

export function DisconnectedScreen() {
  const { error, retryInMs, retryNow, baseUrl, token, configure, status } = useConnection();
  const [urlDraft, setUrlDraft] = useState(baseUrl);
  const [tokenDraft, setTokenDraft] = useState(token);

  const seconds = retryInMs === null ? null : Math.ceil(retryInMs / 1000);

  return (
    <main id="main" className="app-main disconnected" style={{ paddingTop: 'var(--space-16)' }}>
      <h1>The control plane is not answering.</h1>
      <p>
        Husk's console talks to a local daemon. Nothing is cached and nothing is simulated, so until that daemon is up
        there is genuinely nothing to show.
      </p>

      <div className="row-gap-4">
        <div>
          <h2>Start it</h2>
          <div style={{ marginTop: 'var(--space-3)' }}>
            <CopyCommand command="husk serve" />
          </div>
          <p className="hint">
            It binds <code>127.0.0.1:7377</code> by default. From a checkout of this repo, the equivalent is{' '}
            <code>node packages/cli/dist/bin.js serve --port 7377</code>.
          </p>
        </div>

        {error ? <ErrorBlock error={error} /> : null}

        <div className="inline-gap" role="status">
          <Button variant="primary" onClick={retryNow} loading={status === 'connecting'}>
            Retry now
          </Button>
          <span className="status-line tnum">
            {status === 'connecting'
              ? `Probing ${baseUrl}/health…`
              : seconds === null
                ? 'Retrying…'
                : `Retrying automatically in ${seconds}s.`}
          </span>
        </div>

        <details>
          <summary
            style={{
              cursor: 'pointer',
              color: 'var(--color-text-muted)',
              fontSize: 'var(--font-size-sm)',
              minHeight: 'var(--target-min)',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            It is running somewhere else
          </summary>
          <form
            className="form-grid"
            style={{ marginTop: 'var(--space-3)' }}
            onSubmit={(e) => {
              e.preventDefault();
              configure({ baseUrl: urlDraft, token: tokenDraft });
            }}
          >
            <Field label="Control plane URL" htmlFor="conn-url" note="Blank falls back to this page's origin.">
              <input
                id="conn-url"
                className="input mono"
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                placeholder="http://127.0.0.1:7377"
              />
            </Field>
            <Field label="Bearer token" htmlFor="conn-token" note="Only needed when HUSK_TOKEN is set on the server.">
              <input
                id="conn-token"
                className="input mono"
                type="password"
                autoComplete="off"
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
              />
            </Field>
            <div className="field">
              <span className="field-label" aria-hidden="true">
                &nbsp;
              </span>
              <Button type="submit">Use this</Button>
            </div>
          </form>
        </details>
      </div>
    </main>
  );
}
