import { randomBytes } from 'node:crypto';

/**
 * The pages remote access shows its owner, under the public URL: the sign-in
 * a chat app sends them to (the claim code the first time, the passkey after
 * that, then a plain question naming the app), and the page that approves one
 * tool call. No cookies: the id in the page is the session, and it lives for
 * ten minutes in this process alone.
 */

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** What every page script needs: base64url, JSON posts, and the browser's passkey calls. */
const HELPERS = `
  const $ = (id) => document.getElementById(id);
  const bytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  const post = async (path, body) => {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error_description || out.error || 'Husk refused that');
    return out;
  };
  const fail = (err) => { $('error').textContent = err.message || String(err); };
  const passkey = async (step) => {
    const o = step.publicKey;
    if (step.create) {
      const cred = await navigator.credentials.create({ publicKey: { ...o, challenge: bytes(o.challenge), user: { ...o.user, id: bytes(o.user.id) } } });
      return { clientDataJSON: b64(cred.response.clientDataJSON), attestationObject: b64(cred.response.attestationObject) };
    }
    const cred = await navigator.credentials.get({ publicKey: { ...o, challenge: bytes(o.challenge), allowCredentials: o.allowCredentials.map((c) => ({ ...c, id: bytes(c.id) })) } });
    return { id: cred.id, clientDataJSON: b64(cred.response.clientDataJSON), authenticatorData: b64(cred.response.authenticatorData), signature: b64(cred.response.signature) };
  };
`;

function page(title: string, data: unknown, body: string, script: string): { html: string; csp: string } {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escape(title)}</title>
<style nonce="${nonce}">
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 30rem; margin: 3rem auto; padding: 0 1rem; color: #1b1b1f; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e8e8ec; background: #141418; } input { background: #1f1f25; color: inherit; } }
  h1 { font-size: 1.3rem; } .host, code { font-family: ui-monospace, monospace; word-break: break-all; }
  input[type=text] { font: inherit; letter-spacing: .1em; padding: .5rem; width: 100%; box-sizing: border-box; text-transform: uppercase; }
  button { font: inherit; padding: .5rem 1rem; margin: .75rem .5rem 0 0; cursor: pointer; }
  .error { color: #c0392b; } [hidden] { display: none; }
</style>
</head>
<body>
${body}
<p class="error" id="error" role="alert"></p>
<script type="application/json" id="data" nonce="${nonce}">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script nonce="${nonce}">
(() => {
  const data = JSON.parse(document.getElementById('data').textContent);
${HELPERS}
${script}
})();
</script>
</body>
</html>
`;
  return { html, csp };
}

export function authorizePage(data: { request: string; client: string; redirectHost: string; claimed: boolean }): { html: string; csp: string } {
  return page(
    `Husk: allow ${data.client}`,
    data,
    `<h1>Allow <span id="client"></span> to use Husk?</h1>
<p>It will be able to run commands and use the browser on the computers of the Husk on this machine,
and it sees what those return. It answers to <span class="host" id="host"></span>.</p>
<section id="claim" hidden>
  <p>This Husk has no owner yet. Type the claim code it printed where it runs, then make a passkey.
  Only you, with that passkey, can let a chat app in after that.</p>
  <label for="code">Claim code</label>
  <input type="text" id="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX">
  <button id="claim-go">Claim and make a passkey</button>
</section>
<section id="signin" hidden>
  <p>Sign in with this Husk owner's passkey.</p>
  <button id="signin-go">Use my passkey</button>
</section>
<section id="consent" hidden>
  <button id="allow">Allow</button>
  <button id="deny">Deny</button>
</section>`,
    `
  $('client').textContent = data.client;
  $('host').textContent = data.redirectHost;
  const show = (id) => { for (const s of ['claim', 'signin', 'consent']) $(s).hidden = s !== id; };
  const finish = async (step) => { await post('/oauth/passkey', { request: data.request, credential: await passkey(step) }); show('consent'); };
  $('claim-go').onclick = () => post('/oauth/claim', { request: data.request, code: $('code').value }).then(finish).catch(fail);
  $('signin-go').onclick = () => post('/oauth/start', { request: data.request }).then(finish).catch(fail);
  const answer = (allow) => post('/oauth/consent', { request: data.request, allow }).then((r) => location.assign(r.redirect)).catch(fail);
  $('allow').onclick = () => answer(true);
  $('deny').onclick = () => answer(false);
  show(data.claimed ? 'signin' : 'claim');
`,
  );
}

/** One tool call a remote chat wants to make, for the owner to approve with their passkey, or not. */
export function approvalPage(data: { id: string; app: string; tool: string; summary: string }): { html: string; csp: string } {
  return page(
    `Husk: approve ${data.tool}`,
    data,
    `<h1><span id="app"></span> wants to run <code id="tool"></code></h1>
<p><code id="summary"></code></p>
<p>It runs on a computer of this Husk's, not on the machine Husk runs on.</p>
<label><input type="checkbox" id="hour"> Let this app use this tool without asking for the next hour</label>
<section id="ask">
  <button id="allow">Approve with my passkey</button>
  <button id="deny">Deny</button>
</section>
<p id="done" hidden></p>`,
    `
  $('app').textContent = data.app;
  $('tool').textContent = data.tool;
  $('summary').textContent = data.summary;
  const done = (text) => { $('ask').hidden = true; $('done').hidden = false; $('done').textContent = text; };
  $('allow').onclick = async () => {
    try {
      const step = await post('/oauth/approve/start', { id: data.id });
      await post('/oauth/approve', { id: data.id, allow: true, hour: $('hour').checked, credential: await passkey(step) });
      done('Approved. Tell the chat, and it will run the call again.');
    } catch (err) { fail(err); }
  };
  $('deny').onclick = () => post('/oauth/approve', { id: data.id, allow: false }).then(() => done('Denied. Nothing ran.')).catch(fail);
`,
  );
}

/** A page for a request Husk cannot send back to the app: an unknown app, or a redirect it never registered. */
export function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Husk</title></head><body><h1>Husk cannot do that</h1><p>${escape(message)}</p></body></html>`;
}
