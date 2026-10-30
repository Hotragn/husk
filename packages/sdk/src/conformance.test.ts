/**
 * The workspace conformance suite.
 *
 * One question, asked exhaustively: **does `/work/x` name the same file no
 * matter which surface you say it through?**
 *
 * Husk tells an agent that `/work` is its workspace. The agent then reaches
 * that workspace through whichever surface its harness happens to use -- the
 * MCP tools, the HTTP control plane, this SDK, the CLI, or the `Computer`
 * object underneath all of them -- and it has no way to know that those are
 * different code paths. When one of them translates `/work` and another does
 * not, the agent is not looking at a bug it can route around; it is looking at
 * a workspace that changes shape depending on how it was addressed.
 *
 * That is exactly what shipped. File tools mapped `/work` onto the host
 * workspace and the posix shell did not, so `write_file('/work/s.py')`
 * followed by `python3 /work/s.py` failed on the default provider -- the most
 * basic agent workflow there is (QA roadmap HUSK-001, MCP-04, SDK-02). The fix
 * was a shell-side path rewrite; this file is the test that says the fix holds
 * everywhere and keeps holding.
 *
 * **Nothing here is mocked.** Real providers, a real Fastify socket, the real
 * MCP tool dispatcher, the real CLI binary as a child process. A conformance
 * suite built on fixtures would agree with itself and with nothing else, which
 * is the failure mode that let the original mismatch through: every layer had
 * passing tests, and no test crossed a layer.
 *
 * ## The matrix
 *
 * Each surface writes a file only it could have written, and then *every*
 * surface -- including the shell, which is the one that was broken -- reads it
 * back by the same documented path. N writers x N readers, so a surface that
 * quietly keeps its own path space fails against all the others rather than
 * being covered by its own private round trip.
 *
 * ## Providers
 *
 * `local` always runs; it needs neither a daemon nor a network. `docker` runs
 * when a daemon answers, because it is the one provider whose path handling is
 * genuinely different -- the container has a real `/work` and no jail, so it
 * would pass a `local`-only suite for reasons that do not generalise.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@husk-ai/core';
import type { Computer, ComputerProvider } from '@husk-ai/core';
import { callTool } from '@husk-ai/mcp';
import { ComputerManager, DockerProvider, LocalProvider } from '@husk-ai/runtime';
import { Store, createApp } from '@husk-ai/server';
import type { AgentFactory, RouterLike } from '@husk-ai/server';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HuskClient } from './client.js';

const HOME = join(tmpdir(), `husk-conformance-${process.pid}`);
process.env.HUSK_HOME = HOME;
delete process.env.HUSK_TOKEN;

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = join(HERE, '..', '..', 'cli', 'dist', 'bin.js');

/** The path under test. Everything below addresses the workspace this way. */
const GUEST = '/work';

/**
 * Can the `local` provider on this host actually offer `/work`?
 *
 * On posix it rewrites guest paths onto the workspace, and on WSL2 it
 * bind-mounts a real `/work` -- but on a Windows host with no working WSL it
 * falls back to `cmd.exe`, where there is no `/work`, no `sh` and no heredoc.
 * That fallback is deliberate: the provider reports its own raw workspace as
 * `workdir` rather than inventing a path it cannot honour, and the degradation
 * is covered by its own tests in `packages/runtime`.
 *
 * So the question is not "is this Windows" but "did this computer get the
 * `/work` the contract is about", and the provider answers it directly. Asking
 * the provider beats guessing from `process.platform`: this repository is
 * developed on a Windows host *with* WSL2, where the contract does hold and the
 * suite must run.
 */
async function localOffersWork(): Promise<boolean> {
  const p = new LocalProvider();
  const c = await p.create({ name: `conf-probe-${process.pid}` }).catch(() => null);
  if (!c) return false;
  const ok = c.info.workdir === GUEST;
  await c.destroy().catch(() => undefined);
  return ok;
}

/**
 * Is a Docker daemon answering, *and* can it run the images this suite needs?
 *
 * Two separate questions, and asking only the first is how this went red on CI.
 * `docker` being on PATH does not mean a daemon is up -- Docker Desktop installs
 * the CLI and leaves it pointed at one that may be down, and `docker version`
 * exits non-zero in that case. But GitHub's `windows-latest` runner answers that
 * question with a cheerful yes and then cannot pull `debian:bookworm-slim`,
 * because the daemon it is running serves *Windows* containers. The suite booted
 * a provider that looked available and failed on the image.
 *
 * `{{.Server.Os}}` is the field that distinguishes them.
 */
function dockerRunsLinux(): boolean {
  const out = spawnSync('docker', ['version', '--format', '{{.Server.Os}}'], {
    timeout: 20_000,
    encoding: 'utf8',
    windowsHide: true,
  });
  return out.status === 0 && out.stdout?.trim() === 'linux';
}

interface Harness {
  computer: Computer;
  client: HuskClient;
  /** The control-plane id, which is what the HTTP and SDK surfaces address. */
  id: string;
  app: FastifyInstance;
  close(): Promise<void>;
}

const stubRouter: RouterLike = {
  chat: async () => {
    throw new Error('conformance never calls a model');
  },
} as unknown as RouterLike;

const stubAgentFactory: AgentFactory = (() => {
  throw new Error('conformance never runs an agent');
}) as unknown as AgentFactory;

/**
 * Boot the whole stack over one computer.
 *
 * The same `Computer` instance backs every surface, which is the point: if the
 * surfaces disagree about what `/work/x` means, they disagree about one
 * filesystem, and the disagreement is theirs rather than an artefact of testing
 * two different machines.
 */
async function boot(provider: ComputerProvider): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'husk-conf-store-'));
  const store = new Store({ paths: storePathsFor(root) });
  const manager = new ComputerManager({
    providers: [provider],
    logger: createLogger({ level: 'silent' }),
  });
  const info = await manager.create({}).catch((err: unknown) => {
    // A provider that probes available and then refuses to create is the most
    // confusing failure this file can have; say which provider and why.
    const e = err as { code?: string; message?: string; details?: unknown };
    throw new Error(
      `${provider.name} could not create a computer: ${e.code ?? ''} ${e.message ?? String(err)} ` +
        `${JSON.stringify(e.details ?? {})}`,
    );
  });
  const computer = await manager.get(info.id);
  if (!computer) throw new Error(`${provider.name} created ${info.id} and then could not hand it back`);

  const app = await createApp({
    manager,
    router: stubRouter,
    store,
    modelProviders: [],
    agentFactory: stubAgentFactory,
    logger: createLogger({ level: 'silent' }),
    config: {
      host: '127.0.0.1',
      port: 0,
      triggers: false,
      consoleDir: join(root, 'no-console'),
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;

  return {
    computer,
    id: info.id,
    app,
    client: new HuskClient({ baseUrl: `http://127.0.0.1:${port}` }),
    async close() {
      await manager.destroy(info.id).catch(() => undefined);
      await app.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** `Store` wants a full `HuskPaths`; it is a flat layout under one root. */
function storePathsFor(root: string) {
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

/** One way of putting bytes at a guest path. */
interface Writer {
  name: string;
  write(h: Harness, path: string, body: string): Promise<void>;
}

/** One way of getting them back. */
interface Reader {
  name: string;
  read(h: Harness, path: string): Promise<string>;
}

const writers: Writer[] = [
  {
    name: 'runtime Computer.writeFile',
    write: (h, p, body) => h.computer.writeFile(p, body),
  },
  {
    name: 'MCP write_file',
    write: async (h, p, body) => {
      const r = await callTool(h.computer, 'write_file', { path: p, content: body });
      if (r.isError) throw new Error(`MCP write_file failed: ${textOf(r)}`);
    },
  },
  {
    name: 'HTTP PUT /fs/write',
    write: (h, p, body) => h.client.computers.writeFile(h.id, p, body),
  },
  {
    name: 'shell heredoc',
    // The case the fix was actually about: an agent writes a file by shelling
    // out, and the body is prose that mentions the workspace. Rewriting inside
    // the body would change the bytes that land on disk.
    write: async (h, p, body) => {
      const r = await h.computer.exec({ cmd: `cat > ${p} <<'HUSKEOF'\n${body}\nHUSKEOF` });
      if (r.exitCode !== 0) throw new Error(`heredoc write failed: ${r.stderr}`);
    },
  },
];

const readers: Reader[] = [
  {
    name: 'runtime Computer.readTextFile',
    read: (h, p) => h.computer.readTextFile(p),
  },
  {
    name: 'MCP read_file',
    read: async (h, p) => {
      const r = await callTool(h.computer, 'read_file', { path: p });
      if (r.isError) throw new Error(`MCP read_file failed: ${textOf(r)}`);
      return textOf(r);
    },
  },
  {
    name: 'HTTP GET /fs/read',
    read: (h, p) => h.client.computers.readTextFile(h.id, p),
  },
  {
    name: 'shell cat',
    read: async (h, p) => {
      const r = await h.computer.exec({ cmd: `cat ${p}` });
      if (r.exitCode !== 0) throw new Error(`cat failed (${r.exitCode}): ${r.stderr}`);
      return r.stdout;
    },
  },
];

function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content
    .map((c) => c.text ?? '')
    .join('')
    .trim();
}

/** A filename per writer, so a cross-read cannot pass by hitting its own file. */
function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function runSuite(label: string, makeProvider: () => ComputerProvider): void {
  describe(`workspace conformance on ${label}`, () => {
    let h: Harness;

    beforeAll(async () => {
      h = await boot(makeProvider());
    }, 240_000);

    afterAll(async () => {
      await h?.close();
    }, 120_000);

    for (const w of writers) {
      for (const r of readers) {
        it(`${w.name} -> ${r.name}`, async () => {
          const path = `${GUEST}/conf-${slugOf(w.name)}.txt`;
          // The body names the workspace on purpose: a rewriter that walks into
          // file *contents* corrupts this, and a heredoc scanner that mishandles
          // an apostrophe loses quote state for everything after it.
          const body = `written by ${w.name} into ${GUEST}, and it don't move`;
          await w.write(h, path, body);
          expect((await r.read(h, path)).trim()).toBe(body);
        }, 180_000);
      }
    }

    it('executes a script written through the file tools by its /work path', async () => {
      await h.computer.writeFile(`${GUEST}/conf-run.sh`, 'echo CONFORMANCE_EXEC_OK\n');
      const r = await h.computer.exec({ cmd: `sh ${GUEST}/conf-run.sh` });
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe('CONFORMANCE_EXEC_OK');
    }, 180_000);

    it('executes it through the HTTP exec route too', async () => {
      const r = await h.client.computers.exec(h.id, { cmd: `sh ${GUEST}/conf-run.sh` });
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe('CONFORMANCE_EXEC_OK');
    }, 180_000);

    it('executes it through the MCP shell tool too', async () => {
      const r = await callTool(h.computer, 'shell', { command: `sh ${GUEST}/conf-run.sh` });
      expect(r.isError ?? false, textOf(r)).toBe(false);
      expect(textOf(r)).toContain('CONFORMANCE_EXEC_OK');
    }, 180_000);

    it('lists the workspace at /work through every surface that can list', async () => {
      await h.computer.writeFile(`${GUEST}/conf-listed.txt`, 'x');
      const direct = (await h.computer.listDir(GUEST)).map((e) => e.name);
      const http = (await h.client.computers.listDir(h.id, GUEST)).entries.map((e) => e.name);
      const mcp = textOf(await callTool(h.computer, 'list_dir', { path: GUEST }));
      expect(direct).toContain('conf-listed.txt');
      expect(http).toContain('conf-listed.txt');
      expect(mcp).toContain('conf-listed.txt');
    }, 180_000);

    it('does not rewrite a lookalike path into the workspace', async () => {
      // `/workshop` shares a prefix with `/work` and has nothing to do with it.
      // A prefix-match rewrite would silently repoint it at a workspace file,
      // which is worse than the error the agent should get.
      const r = await h.computer.exec({ cmd: `cat ${GUEST}shop/nothing-here 2>&1; echo "rc=$?"` });
      expect(r.stdout).toMatch(/rc=[1-9]/);
      expect(r.stdout).not.toContain('CONFORMANCE_EXEC_OK');
    }, 180_000);

    it('keeps the relative default workdir pointed at the same place as /work', async () => {
      // An agent that omits the path entirely must land in the same directory,
      // or "write a file, then run it from cwd" breaks in the other direction.
      await h.computer.writeFile(`${GUEST}/conf-cwd.txt`, 'CWD_OK');
      const r = await h.computer.exec({ cmd: 'cat conf-cwd.txt' });
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe('CWD_OK');
    }, 180_000);
  });
}

const LOCAL_WORK = await localOffersWork();
describe.skipIf(!LOCAL_WORK)('local', () => {
  runSuite('local', () => new LocalProvider());
});

/**
 * Docker only when a daemon answers *for Linux*. `describe.skipIf` rather than a
 * silent pass: a suite that quietly covers one provider while claiming to cover
 * two is the same species of problem this file exists to catch.
 */
const DOCKER = dockerRunsLinux();
describe.skipIf(!DOCKER)('docker', () => {
  runSuite('docker', () => new DockerProvider());
});

/**
 * The CLI is the sixth surface and the only one that cannot be reached
 * in-process: it is a binary with its own argv parsing, its own path handling
 * and its own computer registry. Driving it as a child process is the only
 * honest way to include it.
 *
 * Skipped when the CLI has not been built -- `npm test` is expected to work in
 * a tree where only some packages have a `dist`, and a missing sibling build is
 * not a conformance failure.
 */
describe.skipIf(!existsSync(CLI_BIN) || !LOCAL_WORK)('workspace conformance through the CLI binary', () => {
  const name = `conf-cli-${process.pid}`;

  function husk(args: string[], timeout = 240_000): { status: number | null; out: string } {
    const r = spawnSync(process.execPath, [CLI_BIN, ...args], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      env: { ...process.env, HUSK_HOME: HOME, NO_COLOR: '1' },
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  beforeAll(() => {
    husk(['up', name, '--provider', 'local']);
  }, 300_000);

  afterAll(() => {
    husk(['rm', name, '--yes'], 120_000);
  }, 180_000);

  it('runs a script it wrote through its own shell, by the documented path', () => {
    const write = husk(['exec', name, '--', `sh -c 'echo CLI_CONFORMANCE_OK > ${GUEST}/conf-cli.txt'`]);
    expect(write.status, write.out).toBe(0);
    const read = husk(['exec', name, '--', `cat ${GUEST}/conf-cli.txt`]);
    expect(read.status, read.out).toBe(0);
    expect(read.out).toContain('CLI_CONFORMANCE_OK');
  }, 300_000);
});
