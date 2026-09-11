/**
 * A recorded MCP session against Husk.
 *
 * Not a simulation of the protocol: this spawns `husk mcp` as a child process
 * and speaks real JSON-RPC 2.0 over stdio, exactly the way Claude Code, Cursor
 * and Zed do. Every line of output came back over that pipe.
 *
 *   node examples/mcp-session-demo.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn('node', [join(root, 'packages/mcp/dist/bin.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, HUSK_LOG_LEVEL: 'error' },
});

let buf = '';
const pending = new Map();
let seq = 0;

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
child.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (s) process.stderr.write('  [server] ' + s + '\n');
});

function rpc(method, params) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const t0 = Date.now();
const banner = (s) => console.log('\n== ' + s);

async function call(name, args = {}) {
  const started = Date.now();
  const res = await rpc('tools/call', { name, arguments: args });
  const text = res.result?.content?.[0]?.text ?? JSON.stringify(res.error ?? res.result);
  const shown = JSON.stringify(args);
  console.log('-> ' + name + ' ' + (shown.length > 88 ? shown.slice(0, 88) + '...' : shown) + '  (' + (Date.now() - started) + 'ms)');
  console.log(
    text
      .split('\n')
      .slice(0, 13)
      .map((l) => '   ' + l)
      .join('\n'),
  );
  return text;
}

banner('1. handshake, exactly what a client sends on connect');
const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'husk-demo-client', version: '0.1.0' },
});
console.log('   server: ' + init.result.serverInfo.name + ' v' + init.result.serverInfo.version);
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

banner('2. what the agent is offered');
const tools = await rpc('tools/list', {});
for (const t of tools.result.tools) {
  console.log('   ' + t.name.padEnd(14) + t.description.split('.')[0].slice(0, 74));
}

banner('3. the agent orients itself: one call instead of six shell probes');
await call('computer_info');

banner('4. it writes a program to its own disk');
await call('write_file', {
  path: '/work/serve.py',
  content: [
    'import http.server, socketserver',
    'class H(http.server.SimpleHTTPRequestHandler):',
    '    def do_GET(self):',
    '        self.send_response(200)',
    "        self.send_header('Content-Type', 'text/html')",
    '        self.end_headers()',
    '        self.wfile.write(b"<html><head><title>Built inside a husk</title></head>"',
    '                         b"<body><h1>It works</h1>"',
    '                         b"<a href=/about>about this machine</a></body></html>")',
    '    def log_message(self, *a): pass',
    "socketserver.TCPServer(('127.0.0.1', 8111), H).serve_forever()",
  ].join('\n'),
});

banner('5. runs it in the background, on its own machine');
await call('shell', { command: 'nohup python3 /work/serve.py >/work/serve.log 2>&1 & sleep 2; echo started' });

banner('6. browses the service it just built, from inside the machine');
await call('browse', { url: 'http://127.0.0.1:8111/' });

banner('7. and the open web, over the same network the shell uses');
await call('browse', { url: 'https://example.com' });

banner('8. the filesystem persisted across every call above');
await call('list_dir', { path: '/work' });

banner('9. the guardrails are real, not decorative');
await call('shell', { command: 'sudo rm -rf /' });
await call('read_file', { path: '/etc/passwd' });

console.log('\ntotal ' + ((Date.now() - t0) / 1000).toFixed(1) + 's, one stdio pipe, no account, no API key');
child.kill();
process.exit(0);
