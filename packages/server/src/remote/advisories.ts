import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The check remote access makes before it serves, and every day after: this
 * install's Husk packages and every runtime dependency they resolve, by name
 * and version only, against the npm registry's bulk advisory endpoint, the
 * one `npm audit` reads. A high or critical advisory keeps remote access off
 * until Husk is upgraded; there is no flag to serve anyway. HUSK_ADVISORY_ENDPOINT
 * points the check elsewhere: a registry that mirrors npm's, or a test's.
 */

export const ADVISORY_ENDPOINT = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';

export interface Advisory {
  name: string;
  version: string;
  title: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  /** The advisory's page; empty unless the registry gave an https one. */
  url: string;
  /** The versions it affects, as the advisory gives them: the way out is a version outside them. */
  vulnerable?: string;
}

const MAX_PACKAGES = 5000;
const DAY_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;

/** Where Node finds `name` from a package in `dir`: the nearest node_modules above it. */
function locate(name: string, dir: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    const file = join(d, 'node_modules', name, 'package.json');
    if (existsSync(file)) return file;
    if (dirname(d) === d) return undefined;
  }
}

/**
 * Every package installed under `root` (a package.json), as name -> versions:
 * its runtime dependencies, theirs, and so on, resolved as Node resolves them.
 * Dev dependencies are not installed with Husk, so they are not walked.
 */
export function installedPackages(roots: string[]): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file) || seen.size >= MAX_PACKAGES) return;
    seen.add(file);
    let pkg: { name?: string; version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(file, 'utf8')) as typeof pkg;
    } catch {
      return;
    }
    if (pkg.name && pkg.version) found.set(pkg.name, (found.get(pkg.name) ?? new Set()).add(pkg.version));
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      const dep = locate(name, dirname(file));
      if (dep) walk(dep);
    }
  };
  for (const root of roots) walk(root);
  return found;
}

/**
 * What the walk starts from: this package, and the Husk packages that run
 * beside it (the MCP server and its SDK, the CLI), wherever this install put them.
 */
export function huskPackages(): string[] {
  let own: string | undefined;
  for (let d = dirname(fileURLToPath(import.meta.url)); !own; d = dirname(d)) {
    if (existsSync(join(d, 'package.json'))) own = join(d, 'package.json');
    else if (dirname(d) === d) throw new Error('@husk-ai/server has no package.json above it');
  }
  const beside = ['@husk-ai/mcp', '@husk-ai/cli'].flatMap((name) => locate(name, dirname(own)) ?? []);
  return [own, ...beside];
}

/** Advisories against these versions, or a thrown error when the registry cannot be asked. */
export async function checkAdvisories(
  packages: Map<string, Set<string>>,
  fetchImpl: typeof fetch = fetch,
  endpoint = process.env.HUSK_ADVISORY_ENDPOINT || ADVISORY_ENDPOINT,
): Promise<Advisory[]> {
  const body = Object.fromEntries([...packages].map(([name, versions]) => [name, [...versions]]));
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`the npm registry answered ${res.status}`);
  const answer = (await res.json()) as Record<string, Array<{ title?: string; severity?: string; url?: string; vulnerable_versions?: string }>>;
  return Object.entries(answer).flatMap(([name, list]) =>
    (Array.isArray(list) ? list : []).map((a) => ({
      name,
      version: [...(packages.get(name) ?? [])].join(', '),
      title: String(a.title ?? 'an advisory'),
      // One the registry does not grade is taken as serious, not waved through.
      severity: (['low', 'moderate', 'high', 'critical'].includes(String(a.severity)) ? a.severity : 'high') as Advisory['severity'],
      url: typeof a.url === 'string' && a.url.startsWith('https://') ? a.url : '',
      ...(typeof a.vulnerable_versions === 'string' ? { vulnerable: a.vulnerable_versions } : {}),
    })),
  );
}

/** This install's own check: its Husk packages and everything they run on. */
export const checkThisInstall = (): Promise<Advisory[]> => checkAdvisories(installedPackages(huskPackages()));

/** The ones that keep remote access off. */
export const blocking = (list: Advisory[]): Advisory[] => list.filter((a) => a.severity === 'high' || a.severity === 'critical');

/** One line per advisory, for a refusal or a warning. */
export const describeAdvisories = (list: Advisory[]): string =>
  list.map((a) => `  ${a.name}@${a.version}: ${a.title} (${a.severity}${a.vulnerable ? `, affects ${a.vulnerable}` : ''}) ${a.url}`.trimEnd()).join('\n');

/**
 * The check on its schedule: once before serving (oauth.ts `start`), then a
 * day after each check, or an hour while the registry could not be asked. A
 * registry that cannot be asked leaves the last list as it was and says why.
 */
export class AdvisoryWatch {
  list: Advisory[] = [];
  checkedAt?: string;
  error?: string;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly check: () => Promise<Advisory[]>,
    private readonly now: () => number = Date.now,
  ) {}

  async run(): Promise<void> {
    try {
      this.list = await this.check();
      this.checkedAt = new Date(this.now()).toISOString();
      this.error = undefined;
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  /** Check again later, and tell `after` each time; until `stop`. */
  schedule(after: () => Promise<void>): void {
    this.timer = setTimeout(
      () =>
        void (async () => {
          await this.run();
          // Off is in force the moment `after` sets it; a failure to save that is no reason to stop checking.
          await after().catch(() => undefined);
          if (this.timer) this.schedule(after);
        })(),
      this.error ? HOUR_MS : DAY_MS,
    );
    this.timer.unref?.();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
