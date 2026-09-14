/**
 * The contract test.
 *
 * This boots the **real** control plane -- `createApp` imported from
 * `@husk-ai/server`, real Fastify, a real listening socket on port 0 -- and drives
 * every public method of `HuskClient` against it over real HTTP and a real
 * WebSocket.
 *
 * Nothing about the transport is mocked, on purpose. A mocked `fetch` is what
 * let this SDK ship with twelve methods pointed at routes that do not exist:
 * every assertion passed against a fixture that agreed with the SDK and with
 * nothing else. The `fetch` wrapper below only *records* method, path and
 * status; it forwards to the platform `fetch` and returns the real response.
 *
 * Computers are real too: a real `ComputerManager` from `@husk-ai/runtime` with
 * the real `LocalProvider`, so `/exec`, `/exec/stream` and every `/fs` route
 * run against an actual guarded working directory. `provider: 'local'` is the
 * one backend that needs neither Docker nor a network, so this works on the
 * machine it was written on and in CI.
 *
 * Two dependencies are stand-ins and cannot be anything else: the model
 * provider and the agent. A real model needs an API key, and CI has none. They
 * are injected exactly where the server already injects them -- so the wire
 * shapes the SDK is being tested against are still produced by the real routes,
 * the real serialiser and the real SSE writer.
 */
import { mkdtemp, rm, writeFile as writeHostFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HuskError, createLogger, defaultSpec } from '@husk-ai/core';
import type {
  ChatRequest,
  ChatResponse,
  HuskSpec,
  ModelProvider,
  RunEvent,
  RunResult,
  StreamEvent,
} from '@husk-ai/core';
import { ComputerManager, LocalProvider } from '@husk-ai/runtime';
import { SERVER_ERROR_CODES, Store, createApp } from '@husk-ai/server';
import type { AgentFactory, AgentLike, RouterLike, ServerRunOptions } from '@husk-ai/server';
import type { FastifyInstance } from 'fastify';
import { WebSocket as NodeWebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HuskClient } from './client.js';
import type { FetchLike, WebSocketCtor } from './http.js';
import type { HuskEventFrame, HuskEventMessage, RunSummary } from './types.js';

/**
 * Every path the control plane touches -- the computer registry, workspaces,
 * husks, runs, transcripts -- hangs off `HUSK_HOME`. Pointing it at a temp
 * directory before anything reads it is what keeps this test off the developer's
 * real `~/.husk`. `paths()` resolves it per call, so setting it here is enough.
 */
const HOME = join(tmpdir(), `husk-sdk-contract-${process.pid}`);
process.env.HUSK_HOME = HOME;
// A token in the ambient environment would silently turn auth on for the
// unauthenticated apps below and fail every call with a 401.
delete process.env.HUSK_TOKEN;
delete process.env.HUSK_HOST;
delete process.env.HUSK_PORT;

// -- the two stand-ins -------------------------------------------------------

/** A model that always answers the same thing, so the wire shape is the variable. */
class StubRouter implements RouterLike {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    return {
      model: req.model,
      text: 'fake reply',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
      latencyMs: 1,
    };
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'start', model: req.model };
    yield { type: 'text_delta', text: 'fake reply' };
    yield { type: 'done', response: await this.chat(req) };
  }
}

const stubModelProvider: ModelProvider = {
  id: 'fake',
  displayName: 'Fake',
  priority: 1,
  isAvailable: async () => ({ available: true }),
  listModels: async () => [
    {
      id: 'fake/tiny',
      provider: 'fake',
      name: 'tiny',
      displayName: 'Tiny',
      contextWindow: 8192,
      maxOutputTokens: 1024,
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      free: true,
    },
  ],
  chat: async (req) => ({
    model: req.model,
    text: 'ok',
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    latencyMs: 1,
  }),
  stream: () => {
    throw new Error('the contract test streams through /v1/models/chat/stream, not this provider');
  },
};

interface AgentScript {
  /** Ask for approval on this tool call before finishing. */
  approvalFor?: { id: string; name: string; args: Record<string, unknown> };
}

/**
 * A scripted agent.
 *
 * It emits the same `RunEvent` sequence a real run does -- `run_start`,
 * `text_delta`, `run_end` -- because those events go through the real runner,
 * the real store and the real SSE writer on their way to the SDK.
 */
function stubAgentFactory(script: AgentScript = {}): AgentFactory {
  return async (): Promise<AgentLike> => {
    const text = 'done';
    const finish = (steps: number): RunResult => ({
      runId: 'agent_own_id',
      text,
      messages: [{ role: 'assistant', content: text }],
      steps,
      usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.001 },
      durationMs: 2,
      stopReason: 'complete',
    });

    const body = async function* (opts: ServerRunOptions): AsyncGenerator<RunEvent> {
      yield { type: 'run_start', runId: 'agent_own_id', husk: 'fake', model: opts.model ?? 'auto' };
      if (script.approvalFor && opts.onApproval) {
        const approved = await opts.onApproval({
          runId: 'agent_own_id',
          huskId: 'fake',
          tool: script.approvalFor.name,
          callId: script.approvalFor.id,
          args: script.approvalFor.args,
          prompt: `run ${script.approvalFor.name}?`,
          dangerous: true,
        });
        yield approved
          ? { type: 'tool_start', call: { type: 'tool_call', ...script.approvalFor } }
          : { type: 'tool_denied', call: { type: 'tool_call', ...script.approvalFor }, reason: 'denied' };
      }
      if (opts.signal?.aborted) throw new Error('aborted');
      yield { type: 'text_delta', text };
      yield { type: 'run_end', result: finish(1) };
    };

    return {
      async run(opts: ServerRunOptions): Promise<RunResult> {
        let result: RunResult | undefined;
        for await (const e of body(opts)) {
          opts.onEvent?.(e);
          if (e.type === 'run_end') result = e.result;
        }
        return result ?? finish(0);
      },
      stream(opts: ServerRunOptions): AsyncIterable<RunEvent> {
        return body(opts);
      },
    };
  };
}

function sampleSpec(name = 'triage'): HuskSpec {
  return { ...defaultSpec(name), description: 'a test husk' };
}

// -- the harness -------------------------------------------------------------

interface WireCall {
  method: string;
  path: string;
  status: number;
}

/** A passthrough recorder. It observes the exchange; it never fabricates one. */
function recorder(): { fetch: FetchLike; calls: WireCall[] } {
  const calls: WireCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const res = await globalThis.fetch(url, init);
    const u = new URL(url);
    calls.push({ method: init?.method ?? 'GET', path: u.pathname + u.search, status: res.status });
    return res;
  };
  return { fetch, calls };
}

interface Live {
  app: FastifyInstance;
  manager: ComputerManager;
  client: HuskClient;
  calls: WireCall[];
  last(): WireCall;
  close(): Promise<void>;
}

async function boot(opts: { token?: string; agent?: AgentFactory; approvalTimeoutMs?: number } = {}): Promise<Live> {
  const root = await mkdtemp(join(tmpdir(), 'husk-sdk-store-'));
  const store = new Store({ paths: storePaths(root) });
  // The real manager, with the one provider that needs neither a daemon nor a
  // network. Registering only `local` also keeps `GET /v1/doctor` deterministic.
  const manager = new ComputerManager({
    providers: [new LocalProvider()],
    logger: createLogger({ level: 'silent' }),
  });

  const app = await createApp({
    manager,
    router: new StubRouter(),
    store,
    modelProviders: [stubModelProvider],
    agentFactory: opts.agent ?? stubAgentFactory(),
    logger: createLogger({ level: 'silent' }),
    config: {
      host: '127.0.0.1',
      port: 0,
      token: opts.token,
      triggers: false,
      // A real console bundle would install a catch-all not-found handler and
      // mask the 404 shape the error tests assert on.
      consoleDir: join(root, 'no-console'),
    },
    ...(opts.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: opts.approvalTimeoutMs }),
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const { fetch, calls } = recorder();
  const client = new HuskClient({
    baseUrl: `http://127.0.0.1:${port}`,
    fetch,
    webSocket: NodeWebSocket as unknown as WebSocketCtor,
    ...(opts.token ? { token: opts.token } : {}),
  });

  return {
    app,
    manager,
    client,
    calls,
    last: () => calls[calls.length - 1]!,
    async close() {
      await app.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** `Store` wants a full `HuskPaths`; it is a flat layout under one root. */
function storePaths(root: string) {
  return {
    root,
    husks: join(root, 'husks'),
    computers: join(root, 'computers'),
    workspaces: join(root, 'workspaces'),
    runs: join(root, 'runs'),
    transcripts: join(root, 'transcripts'),
    data: join(root, 'data'),
    cache: join(root, 'cache'),
    configFile: join(root, 'config.json'),
    envFile: join(root, '.env'),
  };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

async function caught(fn: () => Promise<unknown>): Promise<HuskError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HuskError) return err;
    throw err;
  }
  throw new Error('expected the call to throw');
}

let live: Live;
let client: HuskClient;

beforeAll(async () => {
  live = await boot();
  client = live.client;
  // The first probe of the local provider shells out to `wsl.exe` to work out
  // what kind of shell this machine can offer, which costs seconds on Windows
  // and is then cached. Paying it here keeps it out of the first test's clock.
  await live.manager.status(true);
}, 120_000);

afterAll(async () => {
  // Real computers are real directories. Leave none behind.
  await live?.manager.destroyAll().catch(() => 0);
  await live?.close();
  await rm(HOME, { recursive: true, force: true }).catch(() => {});
}, 120_000);

describe('health and capability', () => {
  it('GET /health -- not /v1/health, and it is the unversioned route', async () => {
    const health = await client.health();
    expect(live.last()).toMatchObject({ method: 'GET', path: '/health', status: 200 });
    expect(health.ok).toBe(true);
    expect(typeof health.version).toBe('string');
    expect(typeof health.uptimeSec).toBe('number');
  });

  it('GET /v1/health does not exist, and says so as E_ROUTE_NOT_FOUND', async () => {
    const err = await caught(() => client.http.request('GET', '/v1/health'));
    expect(live.last().status).toBe(404);
    expect(err.code).toBe('E_ROUTE_NOT_FOUND');
  });

  it('GET /v1/doctor returns a DoctorReport whose selection matches the declared type', async () => {
    const report = await client.doctor();
    expect(live.last()).toMatchObject({ method: 'GET', path: '/v1/doctor', status: 200 });
    expect(Object.keys(report.selection).sort()).toEqual([
      'isolated',
      'model',
      'modelReason',
      'provider',
      'providerReason',
    ]);
    expect(Array.isArray(report.providers)).toBe(true);
    expect(Array.isArray(report.models)).toBe(true);
    expect(Array.isArray(report.warnings)).toBe(true);
    // `isolationKind` lives on a provider, not on `selection`.
    expect(report.selection).not.toHaveProperty('isolationKind');
    const local = report.providers.find((p) => p.name === 'local');
    expect(local).toBeTruthy();
    // The local provider is honest about what it is: guardrails, not a sandbox.
    expect(local!.isolated).toBe(false);
    expect(local!.isolationKind).toBe('guardrails');
    expect(report.selection.provider).toBe('local');
  }, 60_000);
});

describe('computers -- against a real provider: "local"', () => {
  let id: string;

  it('POST /v1/computers answers 201 with a bare ComputerInfo', async () => {
    const info = await client.computers.create({ name: 'contract', provider: 'local', workdir: '/work' });
    expect(live.last()).toMatchObject({ method: 'POST', path: '/v1/computers', status: 201 });
    expect(info).toMatchObject({ name: 'contract', provider: 'local', state: 'running', workdir: '/work' });
    expect(typeof info.id).toBe('string');
    expect(typeof info.createdAt).toBe('string');
    id = info.id;
  }, 60_000);

  it('rejects a spec key the strict server schema does not know, with 422', async () => {
    const err = await caught(() =>
      client.computers.create({ memoryMB: 512 } as unknown as Parameters<typeof client.computers.create>[0]),
    );
    expect(live.last().status).toBe(422);
    expect(err.code).toBe('E_SPEC_INVALID');
  });

  it('GET /v1/computers is enveloped: { computers: ComputerInfo[] }', async () => {
    const res = await client.computers.list();
    expect(live.last()).toMatchObject({ method: 'GET', path: '/v1/computers', status: 200 });
    expect(Array.isArray(res.computers)).toBe(true);
    expect(res.computers.map((c) => c.id)).toContain(id);
  });

  it('GET /v1/computers/:id returns the refreshed info', async () => {
    const info = await client.computers.get(id);
    expect(live.last()).toMatchObject({ method: 'GET', path: `/v1/computers/${id}`, status: 200 });
    expect(info.id).toBe(id);
    expect(info.provider).toBe('local');
  });

  it('stop and start each answer 200 with the new state', async () => {
    expect((await client.computers.stop(id)).state).toBe('stopped');
    expect(live.last()).toMatchObject({ method: 'POST', path: `/v1/computers/${id}/stop`, status: 200 });
    expect((await client.computers.start(id)).state).toBe('running');
    expect(live.last()).toMatchObject({ method: 'POST', path: `/v1/computers/${id}/start`, status: 200 });
  }, 30_000);

  it('POST /exec returns a full ExecResult', async () => {
    const result = await client.computers.exec(id, { cmd: 'echo hi', timeoutSec: 30 });
    expect(live.last()).toMatchObject({ method: 'POST', path: `/v1/computers/${id}/exec`, status: 200 });
    expect(Object.keys(result).sort()).toEqual([
      'durationMs',
      'exitCode',
      'stderr',
      'stdout',
      'timedOut',
      'truncated',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hi');
    expect(result.timedOut).toBe(false);
  }, 60_000);

  it('exec accepts every field the strict schema declares, including tty and user', async () => {
    const result = await client.computers.exec(id, {
      cmd: ['echo', 'hi'],
      cwd: '/work',
      env: { HUSK_CONTRACT: 'b' },
      timeoutSec: 30,
      stdin: '',
      tty: false,
      user: 'husk',
      maxOutputBytes: 4096,
    });
    expect(live.last().status).toBe(200);
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it('refuses a denied command with E_EXEC_DENIED rather than running it', async () => {
    const err = await caught(() => client.computers.exec(id, { cmd: 'sudo rm -rf /' }));
    expect(err.code).toBe('E_EXEC_DENIED');
    expect(live.last().status).toBe(403);
  }, 30_000);

  it('exec/stream carries `data`, not `text`, and does not yield the done frame', async () => {
    const events = await collect(client.computers.execStream(id, { cmd: 'echo hi' }));
    expect(live.last()).toMatchObject({ method: 'POST', path: `/v1/computers/${id}/exec/stream`, status: 200 });

    // Output arrives in however many chunks the OS pipe delivered; the shape of
    // each frame is what is under test, and the last one is always the exit.
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(['stdout', 'exit']));
    const stdout = events.filter((e) => e.type === 'stdout');
    expect(stdout.length).toBeGreaterThan(0);
    for (const frame of stdout) {
      if (frame.type !== 'stdout') throw new Error('unreachable');
      expect(typeof frame.data).toBe('string');
      expect(frame).not.toHaveProperty('text');
    }
    expect(stdout.map((e) => (e as { data: string }).data).join('')).toContain('hi');

    const exit = events.at(-1);
    if (exit?.type !== 'exit') throw new Error('expected an exit frame last');
    expect(exit.result.exitCode).toBe(0);

    // The regression this file exists for: the server terminates with
    // `event: done\ndata: {}`, and the old reader yielded that `{}` as an event.
    expect(events.some((e) => Object.keys(e).length === 0)).toBe(false);
  }, 60_000);

  it('writes, lists, reads and removes a file through the /fs routes', async () => {
    await client.computers.writeFile(id, '/work/a.txt', 'hello');
    expect(live.last()).toMatchObject({
      method: 'PUT',
      path: `/v1/computers/${id}/fs/write?path=%2Fwork%2Fa.txt`,
      status: 204,
    });

    const listed = await client.computers.listDir(id, '/work');
    expect(live.last()).toMatchObject({ method: 'GET', path: `/v1/computers/${id}/fs?path=%2Fwork`, status: 200 });
    expect(listed.entries.map((e) => e.path)).toContain('/work/a.txt');
    const entry = listed.entries.find((e) => e.path === '/work/a.txt')!;
    expect(entry).toMatchObject({ name: 'a.txt', type: 'file', size: 5 });

    const bytes = await client.computers.readFile(id, '/work/a.txt');
    expect(live.last()).toMatchObject({
      method: 'GET',
      path: `/v1/computers/${id}/fs/read?path=%2Fwork%2Fa.txt`,
      status: 200,
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes)).toBe('hello');
    expect(await client.computers.readTextFile(id, '/work/a.txt')).toBe('hello');

    await client.computers.remove(id, '/work/a.txt', { recursive: true });
    expect(live.last()).toMatchObject({
      method: 'DELETE',
      path: `/v1/computers/${id}/fs?path=%2Fwork%2Fa.txt&recursive=true`,
      status: 204,
    });
    expect((await client.computers.listDir(id, '/work')).entries.map((e) => e.path)).not.toContain('/work/a.txt');
  }, 60_000);

  it('round-trips bytes that are not valid UTF-8', async () => {
    const raw = new Uint8Array([0x00, 0xff, 0xfe, 0x10, 0x80]);
    await client.computers.writeFile(id, '/work/blob.bin', raw);
    expect(live.last().status).toBe(204);
    expect(Array.from(await client.computers.readFile(id, '/work/blob.bin'))).toEqual(Array.from(raw));
    await client.computers.remove(id, '/work/blob.bin');
  }, 30_000);

  it('a missing ?path= is a 422 from the server, not a silent listing of /', async () => {
    const err = await caught(() => client.computers.listDir(id, ''));
    expect(live.last().status).toBe(422);
    expect(err.code).toBe('E_SPEC_INVALID');
    expect(err.hint).toContain('path=');
  });

  it('reading a file that is not there is E_FS_DENIED, not a 200 with an empty body', async () => {
    const err = await caught(() => client.computers.readFile(id, '/work/missing.txt'));
    expect(err.code).toBe('E_FS_DENIED');
    expect(live.last().status).toBe(403);
  });

  it('POST /ports returns a PortBinding', async () => {
    const binding = await client.computers.exposePort(id, 8080);
    expect(live.last()).toMatchObject({ method: 'POST', path: `/v1/computers/${id}/ports`, status: 200 });
    expect(binding).toMatchObject({ hostPort: 8080 });
    expect(typeof binding.url).toBe('string');
  });

  it('DELETE /v1/computers/:id answers 204 and resolves to undefined', async () => {
    await expect(client.computers.destroy(id)).resolves.toBeUndefined();
    expect(live.last()).toMatchObject({ method: 'DELETE', path: `/v1/computers/${id}`, status: 204 });
    const err = await caught(() => client.computers.get(id));
    expect(err.code).toBe('E_COMPUTER_NOT_FOUND');
  }, 30_000);
});

describe('husks', () => {
  const spec = sampleSpec('contract-husk');

  it('POST /v1/husks takes { spec } and answers 201 with a HuskSummary', async () => {
    const summary = await client.husks.create({ spec });
    expect(live.last()).toMatchObject({ method: 'POST', path: '/v1/husks', status: 201 });
    expect(summary).toMatchObject({ name: 'contract-husk', runCount: 0 });
    expect(summary.computer).toMatchObject({ enabled: expect.any(Boolean), flavor: expect.any(String) });
    // A summary is not a spec: it has no persona and no apiVersion.
    expect(summary).not.toHaveProperty('persona');
  });

  it('accepts a YAML body too', async () => {
    const created = await client.husks.create({ yaml: 'name: yaml-husk\npersona: You are terse.\n' });
    expect(live.last().status).toBe(201);
    expect(created.name).toBe('yaml-husk');
    await client.husks.delete('yaml-husk');
    expect(live.last()).toMatchObject({ method: 'DELETE', path: '/v1/husks/yaml-husk', status: 204 });
  });

  it('GET /v1/husks is enveloped: { husks: HuskSummary[] }', async () => {
    const res = await client.husks.list();
    expect(live.last()).toMatchObject({ method: 'GET', path: '/v1/husks', status: 200 });
    expect(res.husks.map((h) => h.name)).toContain('contract-husk');
  });

  it('GET /v1/husks/:name returns { spec, yaml }, not a bare spec', async () => {
    const doc = await client.husks.get('contract-husk');
    expect(live.last()).toMatchObject({ method: 'GET', path: '/v1/husks/contract-husk', status: 200 });
    expect(doc.spec.name).toBe('contract-husk');
    expect(typeof doc.yaml).toBe('string');
    expect(doc.yaml).toContain('contract-husk');
  });

  it('PUT /v1/husks/:name answers 200 with the updated summary', async () => {
    const summary = await client.husks.update('contract-husk', {
      spec: { ...spec, description: 'edited by the contract test' },
    });
    expect(live.last()).toMatchObject({ method: 'PUT', path: '/v1/husks/contract-husk', status: 200 });
    expect(summary.description).toBe('edited by the contract test');
  });

  it('validate takes { spec } and answers 200 with { ok: true }', async () => {
    const ok = await client.husks.validate({ spec });
    expect(live.last()).toMatchObject({ method: 'POST', path: '/v1/husks/validate', status: 200 });
    expect(ok).toEqual({ ok: true });
  });

  it('validate reports an invalid spec as ok:false with issues, still 200', async () => {
    const bad = await client.husks.validate({ spec: { persona: 'no name' } });
    expect(live.last().status).toBe(200);
    expect(bad.ok).toBe(false);
    expect(bad.issues?.length).toBeGreaterThan(0);
    // The old SDK posted a bare spec, so the server answered this question --
    // "did you send an envelope?" -- instead of the one the caller asked.
    expect(bad.issues).not.toContain('body must carry either `spec` or `yaml`');
  });

  it('validate accepts YAML as well, and reports unparseable YAML as an issue', async () => {
    expect(await client.husks.validate({ yaml: 'name: from-yaml\npersona: terse\n' })).toEqual({ ok: true });
    const bad = await client.husks.validate({ yaml: 'name: [unclosed\n' });
    expect(live.last().status).toBe(200);
    expect(bad.ok).toBe(false);
  });

  it('POST /v1/husks/:name/run -- singular `run` -- returns a RunResult', async () => {
    const result = await client.husks.run('contract-husk', { input: 'hello' });
    expect(live.last()).toMatchObject({ method: 'POST', path: '/v1/husks/contract-husk/run', status: 200 });
    expect(typeof result.runId).toBe('string');
    expect(result.text).toBe('done');
    expect(result.stopReason).toBe('complete');
    expect(result.usage).toMatchObject({ inputTokens: expect.any(Number), outputTokens: expect.any(Number) });
  });

  it('run/stream yields RunEvents verbatim and stops at the done frame', async () => {
    const events = await collect(client.husks.runStream('contract-husk', { input: 'hello' }));
    expect(live.last()).toMatchObject({ method: 'POST', path: '/v1/husks/contract-husk/run/stream', status: 200 });
    expect(events.map((e) => e.type)).toEqual(['run_start', 'text_delta', 'run_end']);
    expect(events.some((e) => Object.keys(e).length === 0)).toBe(false);
    const end = events.at(-1);
    if (end?.type !== 'run_end') throw new Error('expected a run_end');
    expect(end.result.text).toBe('done');
  });

  it('an empty input is a 422 the server explains', async () => {
    const err = await caught(() => client.husks.run('contract-husk', { input: '' }));
    expect(live.last().status).toBe(422);
    expect(err.code).toBe('E_SPEC_INVALID');
    expect(err.message).toContain('input');
  });
});

describe('runs', () => {
  let runId: string;

  beforeAll(async () => {
    runId = (await client.husks.run('contract-husk', { input: 'a run to inspect' })).runId;
  }, 30_000);

  it('GET /v1/runs is { runs, nextCursor? }', async () => {
    const res = await client.runs.list({ limit: 10 });
    expect(live.last()).toMatchObject({ method: 'GET', path: '/v1/runs?limit=10', status: 200 });
    expect(Array.isArray(res.runs)).toBe(true);
    const mine = res.runs.find((r) => r.runId === runId);
    expect(mine).toBeTruthy();
    // `status`, not `state`; several fields the old type marked required are not.
    expect(mine).toHaveProperty('status');
    expect(mine).not.toHaveProperty('state');
    expect(mine!.status).toBe('complete');
    expect(mine!.husk).toBe('contract-husk');
  });

  it('filters by husk', async () => {
    const res = await client.runs.list({ husk: 'contract-husk' });
    expect(live.last().path).toBe('/v1/runs?husk=contract-husk');
    expect(res.runs.every((r: RunSummary) => r.husk === 'contract-husk')).toBe(true);
  });

  it('GET /v1/runs/:runId is { result, events }, not a bare RunResult', async () => {
    const detail = await client.runs.get(runId);
    expect(live.last()).toMatchObject({ method: 'GET', path: `/v1/runs/${runId}`, status: 200 });
    expect(Array.isArray(detail.events)).toBe(true);
    expect(detail.result).toBeTruthy();
    expect(detail.events.map((e) => e.type)).toContain('run_end');
  });

  it('POST /v1/runs/:runId/cancel answers 202, idempotently, for a finished run', async () => {
    const res = await client.runs.cancel(runId);
    expect(live.last()).toMatchObject({ method: 'POST', path: `/v1/runs/${runId}/cancel`, status: 202 });
    expect(res).toMatchObject({ runId, cancelled: false });
    expect(res.status).toBe('complete');
  });

  it('DELETE /v1/runs/:runId answers 204', async () => {
    await expect(client.runs.delete(runId)).resolves.toBeUndefined();
    expect(live.last()).toMatchObject({ method: 'DELETE', path: `/v1/runs/${runId}`, status: 204 });
    const err = await caught(() => client.runs.get(runId));
    expect(err.code).toBe('E_RUN_NOT_FOUND');
  });
});

describe('approvals', () => {
  it('lists a pending approval and answers it, unblocking the run', async () => {
    const asking = await boot({
      agent: stubAgentFactory({ approvalFor: { id: 'call_1', name: 'shell', args: { cmd: 'rm -rf /' } } }),
      approvalTimeoutMs: 10_000,
    });
    try {
      await asking.client.husks.create({ spec: sampleSpec('asker') });

      const empty = await asking.client.approvals.list();
      expect(asking.last()).toMatchObject({ method: 'GET', path: '/v1/approvals', status: 200 });
      expect(empty.approvals).toEqual([]);

      const running = asking.client.husks.run('asker', { input: 'go', approvalMode: 'ask' });

      let pending = (await asking.client.approvals.list()).approvals;
      for (let i = 0; i < 100 && pending.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
        pending = (await asking.client.approvals.list()).approvals;
      }
      expect(pending).toHaveLength(1);
      const approval = pending[0]!;
      expect(approval).toMatchObject({ husk: 'asker', call: { type: 'tool_call', name: 'shell' } });
      expect(typeof approval.expiresAt).toBe('string');

      const answered = await asking.client.approvals.answer(approval.approvalId, { approve: true });
      expect(asking.last()).toMatchObject({
        method: 'POST',
        path: `/v1/approvals/${approval.approvalId}`,
        status: 200,
      });
      expect(answered).toEqual({ approvalId: approval.approvalId, approved: true, remembered: false });

      await expect(running).resolves.toMatchObject({ stopReason: 'complete' });

      const err = await caught(() => asking.client.approvals.answer('apr_nope', { approve: false }));
      expect(err.code).toBe('E_APPROVAL_NOT_FOUND');
    } finally {
      await asking.close();
    }
  }, 60_000);
});

describe('sessions', () => {
  let root: string;
  let transcriptId: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'husk-sdk-sessions-'));
    await writeHostFile(
      join(root, 'session.jsonl'),
      `${JSON.stringify({ summary: 'a recorded session' })}\n${JSON.stringify({ role: 'user', content: 'hi' })}\n`,
      'utf8',
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('GET /v1/sessions/discover -- not /v1/sessions -- and it is enveloped', async () => {
    const res = await client.sessions.discover({ source: 'claude-code', path: root });
    expect(live.last()).toMatchObject({ method: 'GET', status: 200 });
    expect(live.last().path.startsWith('/v1/sessions/discover?')).toBe(true);
    expect(res.sessions).toHaveLength(1);
    const found = res.sessions[0]!;
    // The file path is `origin`. There is no `path` and no `sizeBytes` field.
    expect(found).toMatchObject({ source: 'claude-code', title: 'a recorded session', messageCount: 2 });
    expect(found.origin).toContain('session.jsonl');
    expect(found).not.toHaveProperty('path');
  });

  it('POST /v1/sessions/import returns { transcript }, not an array', async () => {
    const res = await client.sessions.import({ content: '# chat\n\n## User\nhi\n', source: 'markdown' });
    expect(live.last()).toMatchObject({ method: 'POST', path: '/v1/sessions/import', status: 200 });
    expect(Array.isArray(res)).toBe(false);
    expect(res.transcript.messages.length).toBeGreaterThan(0);
    transcriptId = res.transcript.id;
  });

  it('an import with neither path nor content is E_IMPORT_FAILED', async () => {
    const err = await caught(() => client.sessions.import({}));
    expect(err.code).toBe('E_IMPORT_FAILED');
  });

  it('POST /v1/sessions/distill returns { distilled, spec, yaml }', async () => {
    const res = await client.sessions.distill({ transcriptId });
    expect(live.last()).toMatchObject({ method: 'POST', path: '/v1/sessions/distill', status: 200 });
    // The key is `distilled`. The old SDK typed it `agent`, so it was always undefined.
    expect(res).not.toHaveProperty('agent');
    expect(res.distilled).toBeTruthy();
    expect(typeof res.distilled.name).toBe('string');
    expect(typeof res.spec.name).toBe('string');
    expect(res.yaml).toContain(res.spec.name);
  }, 30_000);

  it('distill/stream emits progress frames then exactly one done', async () => {
    const events = await collect(client.sessions.distillStream({ transcriptId }));
    expect(live.last()).toMatchObject({ method: 'POST', path: '/v1/sessions/distill/stream', status: 200 });
    const stages = events.filter((e) => e.type === 'progress').map((e) => (e as { stage: string }).stage);
    expect(stages).toEqual(['scanning', 'extracting', 'merging']);
    const done = events.filter((e) => e.type === 'done');
    expect(done).toHaveLength(1);
    expect(events.some((e) => Object.keys(e).length === 0)).toBe(false);
  }, 30_000);

  it('an unknown transcript id decodes as E_TRANSCRIPT_NOT_FOUND', async () => {
    const err = await caught(() => client.sessions.distill({ transcriptId: 'nope' }));
    expect(live.last().status).toBe(404);
    expect(err.code).toBe('E_TRANSCRIPT_NOT_FOUND');
  });

  it('an error raised mid-stream arrives as a throw, not as a data frame', async () => {
    const err = await caught(() => collect(client.sessions.distillStream({ transcriptId: 'nope' })));
    expect(err.code).toBe('E_TRANSCRIPT_NOT_FOUND');
    expect(err.details).toMatchObject({ stream: true });
  });
});

describe('models', () => {
  it('GET /v1/models is { models, providers }', async () => {
    const res = await client.models.list();
    expect(live.last()).toMatchObject({ method: 'GET', path: '/v1/models', status: 200 });
    expect(res.models.map((m) => m.id)).toContain('fake/tiny');
    expect(res.providers.map((p) => p.id)).toContain('fake');
    expect(res.providers[0]).toMatchObject({ available: expect.any(Boolean), priority: expect.any(Number) });
  });

  it('POST /v1/models/chat returns a full ChatResponse, not { text, model }', async () => {
    const res = await client.models.chat({ model: 'fake/tiny', messages: [{ role: 'user', content: 'hi' }] });
    expect(live.last()).toMatchObject({ method: 'POST', path: '/v1/models/chat', status: 200 });
    expect(res).toMatchObject({ model: 'fake/tiny', text: 'fake reply', finishReason: 'stop' });
    expect(res.usage).toMatchObject({ inputTokens: expect.any(Number) });
    expect(Array.isArray(res.toolCalls)).toBe(true);
  });

  it('chat validates against the server schema: an empty messages array is 422', async () => {
    const err = await caught(() => client.models.chat({ model: 'fake/tiny', messages: [] }));
    expect(live.last().status).toBe(422);
    expect(err.code).toBe('E_SPEC_INVALID');
  });

  it('chat/stream yields StreamEvents and stops at the done frame', async () => {
    const events = await collect(
      client.models.chatStream({ model: 'fake/tiny', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(live.last()).toMatchObject({ method: 'POST', path: '/v1/models/chat/stream', status: 200 });
    expect(events.map((e) => e.type)).toEqual(['start', 'text_delta', 'done']);
    expect(events.some((e) => Object.keys(e).length === 0)).toBe(false);
  });

  it('an AbortSignal ends a stream without throwing a transport error', async () => {
    const ac = new AbortController();
    const seen: StreamEvent[] = [];
    for await (const ev of client.models.chatStream(
      { model: 'fake/tiny', messages: [{ role: 'user', content: 'hi' }] },
      { signal: ac.signal },
    )) {
      seen.push(ev);
      ac.abort();
      break;
    }
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe('the /v1/events websocket', () => {
  it('says hello, honours a subscribe, answers a ping and carries live events', async () => {
    const stream = client.events();
    try {
      await stream.opened();
      const iterator = stream[Symbol.asyncIterator]();
      const next = async (): Promise<HuskEventFrame> => {
        const r = await iterator.next();
        if (r.done) throw new Error('the event socket closed early');
        return r.value;
      };
      /**
       * `subscribe` also replays the matching backlog, so the frame we are
       * waiting for arrives behind however much history this file has already
       * generated. Skip forward rather than assume an empty bus.
       */
      const until = async (type: string): Promise<HuskEventFrame> => {
        for (let i = 0; i < 200; i++) {
          const frame = await next();
          if (frame.type === type) return frame;
        }
        throw new Error(`no ${type} frame arrived`);
      };

      const hello = (await next()) as HuskEventMessage;
      expect(hello).toMatchObject({ type: 'hello', topic: 'providers' });
      expect(typeof hello.at).toBe('string');
      expect(hello.payload).toMatchObject({ topics: expect.any(Array) });

      stream.subscribe(['computers']);
      const subscribed = await next();
      expect(subscribed).toMatchObject({ type: 'subscribed', topics: ['computers'] });

      stream.ping();
      expect(await until('pong')).toMatchObject({ type: 'pong' });

      const created = await client.computers.create({ name: 'ws-watch', provider: 'local' });
      const frame = (await until('computer_created')) as HuskEventMessage;
      expect(frame).toMatchObject({ type: 'computer_created', topic: 'computers' });
      expect(frame.payload).toMatchObject({ id: created.id });

      await client.computers.destroy(created.id);
    } finally {
      stream.close();
    }
  }, 60_000);

  it('ends the iterator when the socket closes', async () => {
    const stream = client.events();
    await stream.opened();
    stream.close();
    await expect(collect(stream)).resolves.toBeInstanceOf(Array);
  }, 30_000);
});

describe('error decoding round-trips the server code', () => {
  it('E_ROUTE_NOT_FOUND is not reported as E_COMPUTER_NOT_FOUND', async () => {
    const err = await caught(() => client.http.request('GET', '/v1/no-such-route'));
    expect(live.last().status).toBe(404);
    expect(err.code).toBe('E_ROUTE_NOT_FOUND');
    expect(err.details).not.toHaveProperty('unrecognizedCode');
    expect(err.hint).toContain('docs/API.md');
  });

  it.each([
    ['computer', 'E_COMPUTER_NOT_FOUND', () => client.computers.get('cmp_nope')],
    ['husk', 'E_HUSK_NOT_FOUND', () => client.husks.get('no-such-husk')],
    ['run', 'E_RUN_NOT_FOUND', () => client.runs.get('run_nope')],
    ['transcript', 'E_TRANSCRIPT_NOT_FOUND', () => client.sessions.distill({ transcriptId: 'nope' })],
  ])('a missing %s decodes as %s', async (_kind, code, call) => {
    const err = await caught(call);
    expect(live.last().status).toBe(404);
    expect(err.code).toBe(code);
    expect(typeof err.hint).toBe('string');
    expect(err.details).toMatchObject({ status: 404 });
  });

  it('carries the server hint and the request url through', async () => {
    const err = await caught(() => client.computers.get('cmp_nope'));
    expect(err.hint).toContain('husk ps');
    expect(String(err.details?.url)).toContain('/v1/computers/cmp_nope');
  });

  it('every code the server can emit is one the SDK recognises', async () => {
    // Cross-checked against the server's own exported list, not a copy of it.
    const { KNOWN_CODES } = await import('./errors.js');
    for (const code of SERVER_ERROR_CODES) expect(KNOWN_CODES.has(code)).toBe(true);
  });
});

/**
 * The README used to print `undefined` for every byte of stdout, because its
 * example read `ev.text` off an event the server sends as `ev.data`. These run
 * its snippets against the live server so that cannot recur silently.
 */
describe('the README examples', () => {
  it('runs the quickstart end to end', async () => {
    const box = await client.computers.create({ name: 'scratch' });
    expect(typeof box.name).toBe('string');
    expect(typeof box.provider).toBe('string');

    await client.computers.writeFile(box.id, '/work/greeting.txt', 'hello from husk\n');

    const written: string[] = [];
    let exitCode: number | undefined;
    for await (const ev of client.computers.execStream(box.id, { cmd: 'echo hi' })) {
      if (ev.type === 'stdout') written.push(ev.data);
      if (ev.type === 'stderr') written.push(ev.data);
      if (ev.type === 'exit') exitCode = ev.result.exitCode;
    }
    // Every field the example reads has to exist and be a string -- `ev.text`
    // was `undefined`, and `process.stdout.write(undefined)` prints nothing.
    expect(written.every((s) => typeof s === 'string')).toBe(true);
    expect(written.join('')).not.toContain('undefined');
    expect(written.join('')).toContain('hi');
    expect(exitCode).toBe(0);

    expect(await client.computers.readTextFile(box.id, '/work/greeting.txt')).toBe('hello from husk\n');

    await client.computers.destroy(box.id);
  }, 60_000);

  it('runs the envelope-destructuring snippets', async () => {
    const { computers } = await client.computers.list();
    const { husks } = await client.husks.list();
    const { runs, nextCursor } = await client.runs.list({ husk: 'contract-husk', limit: 50 });
    expect(Array.isArray(computers)).toBe(true);
    expect(Array.isArray(husks)).toBe(true);
    expect(Array.isArray(runs)).toBe(true);
    expect(nextCursor === undefined || typeof nextCursor === 'string').toBe(true);

    const box = await client.computers.create({});
    const { entries } = await client.computers.listDir(box.id, '/work');
    expect(Array.isArray(entries)).toBe(true);
    await client.computers.destroy(box.id);
  }, 60_000);

  it('runs the husk create / validate snippets', async () => {
    await client.husks.create({ spec: { name: 'triage', persona: 'You triage bugs.' } });
    await client.husks.delete('triage');
    await client.husks.create({ yaml: 'name: triage\npersona: You triage bugs.\n' });
    await client.husks.delete('triage');

    const check = await client.husks.validate({ spec: { persona: 'no name' } });
    expect(check.ok).toBe(false);
    expect(Array.isArray(check.issues)).toBe(true);
  });

  it('runs the approvals snippet against an empty queue', async () => {
    const { approvals } = await client.approvals.list();
    expect(Array.isArray(approvals)).toBe(true);
    for (const a of approvals) await client.approvals.answer(a.approvalId, { approve: false });
  });

  it('runs the error-handling snippet: isHuskError narrows a thrown failure', async () => {
    const { isHuskError } = await import('./index.js');
    try {
      await client.computers.get('cmp_definitely_not_here');
      throw new Error('expected a throw');
    } catch (err) {
      expect(isHuskError(err)).toBe(true);
      if (isHuskError(err)) {
        expect(typeof err.code).toBe('string');
        expect(typeof err.message).toBe('string');
        expect(typeof err.hint).toBe('string');
      }
    }
  });
});

describe('auth', () => {
  it('leaves /health open and requires a bearer token everywhere else', async () => {
    const secured = await boot({ token: 'sekret' });
    try {
      await expect(secured.client.health()).resolves.toMatchObject({ ok: true });
      const listed = await secured.client.computers.list();
      expect(Array.isArray(listed.computers)).toBe(true);

      const anonymous = new HuskClient({ baseUrl: secured.client.baseUrl, token: '' });
      await expect(anonymous.health()).resolves.toMatchObject({ ok: true });
      const err = await caught(() => anonymous.computers.list());
      expect(err.code).toBe('E_NO_CREDENTIALS');
      expect(err.details).toMatchObject({ status: 401 });
    } finally {
      await secured.close();
    }
  }, 60_000);

  it('authenticates the events websocket with ?token=, which a browser cannot header', async () => {
    const secured = await boot({ token: 'sekret' });
    try {
      expect(secured.client.http.wsUrl('/v1/events')).toContain('token=sekret');
      const stream = secured.client.events();
      await stream.opened();
      const first = await stream[Symbol.asyncIterator]().next();
      expect(first.value).toMatchObject({ type: 'hello' });
      stream.close();
    } finally {
      await secured.close();
    }
  }, 60_000);
});
