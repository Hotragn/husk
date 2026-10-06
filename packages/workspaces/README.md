# @husk-ai/workspaces

Durable local text workspaces for Husk's starter profile. The package works without a computer provider, shell, browser install, model key, or Husk account. The AI host receives source text when its tools request it; the host's own data handling terms apply.

```ts
import { WorkspaceStore } from '@husk-ai/workspaces';

const store = new WorkspaceStore();
const workspace = await store.create('Website comparison');
const { source } = await store.addSource(workspace.id, 'https://example.com');
await store.write(workspace.id, 'brief.md', '# My brief', [source.id]);
const reopened = await store.open('Website comparison');
const archive = await store.export(reopened.id);
```

Workspaces live under `$HUSK_HOME/workspaces/ws_<uuid>` (default `~/.husk/workspaces`). The `ws_` namespace excludes existing local computer directories. Output files live under `outputs/`; captured source text lives under `sources/`. The manifest records source URLs, capture time, title, excerpt, truncation, content type and SHA-256 of saved text. A hash records what was saved; it is not a fact-check.

Names are unique without regard to case. Every store operation acquires the same process-shared directory lock. Mutations flush a recovery journal before atomically replacing file content and the manifest; the next operation replays an interrupted mutation. A process killed abruptly may leave a lock for up to 30 seconds. Do not manually remove locks while Husk is running. Keep the live state on a local filesystem; use export or backups to move it between machines.

Public HTTP and HTTPS pages are fetched from the user's device, without cookies or authorization. All DNS results must be public, the selected address is pinned to the socket, and every redirect is checked again. Requests have a 20-second overall timeout, five redirects, and a 2 MiB body limit. Supported sources are HTML, XHTML, plain text, and Markdown; JavaScript and sign-in pages may have no readable text. Compressed responses are refused when a server ignores the requested identity encoding. Returned page text is untrusted content and must never be treated as instructions by a caller.

Each output/source is limited to 2 MiB; each workspace holds at most 100 sources, 100 outputs and 32 MiB of text. Exports are standard ZIP files containing the manifest and exact saved source/output text. Deletion requires the exact workspace name. Paths reject traversal, links/junctions, Windows device names and dangerous object keys. These checks protect tool input; they do not create an OS security boundary against another process already running as the same user.

Design references: [Node HTTP request and lookup options](https://nodejs.org/api/http.html#httprequesturl-options-callback), [Node filesystem APIs](https://nodejs.org/api/fs.html), [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html), and [proper-lockfile design](https://github.com/moxystudio/node-proper-lockfile#design). Address checks plus socket pinning follow OWASP's DNS-rebinding guidance; atomic writes and serialized operations address Node's warning about concurrent writes to the same file.
