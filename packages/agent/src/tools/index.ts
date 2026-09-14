import type { HuskSpec, Logger, Tool } from '@husk-ai/core';
import { asTools } from '../types.js';
import type { AgentTool } from '../types.js';
import { browserTools } from './browse.js';
import { realBrowserTools } from './browser.js';
import { computerTools } from './computer.js';
import { fileTools } from './files.js';
import { httpTools } from './http.js';
import { makeWebSearch, searchBackend, webTools } from './web.js';

export * from './browse.js';
export * from './browser.js';
export * from './computer.js';
export * from './files.js';
export * from './http.js';
export * from './web.js';

export const BUNDLES = {
  computer: () => computerTools,
  // The zero-dependency `browse` and the real Chromium ship in the same bundle:
  // the model picks per page, and the fallback still works on a machine where
  // Chromium cannot be provisioned at all.
  browser: () => [...browserTools, ...realBrowserTools],
  files: () => fileTools,
  web: () => webTools,
  http: () => httpTools,
} as const;

export type BundleName = keyof typeof BUNDLES;

export function isBundle(name: string): name is BundleName {
  return name in BUNDLES;
}

export interface ResolveToolsOptions {
  spec: HuskSpec;
  /** False when this husk has no machine, so tools that need one are skipped. */
  hasComputer?: boolean;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

/**
 * Expand bundle names and individual tool names into concrete tools.
 *
 * Anything that cannot work here is skipped rather than registered-and-broken.
 * A tool the model can see is a promise that calling it will do something.
 */
export function resolveTools(names: string[], opts: ResolveToolsOptions): Tool[] {
  const env = opts.env ?? process.env;
  const hasComputer = opts.hasComputer ?? true;

  const catalogue = new Map<string, AgentTool>();
  for (const t of [...computerTools, ...browserTools, ...realBrowserTools, ...fileTools, ...webTools, ...httpTools])
    catalogue.set(t.name, t);

  const search = searchBackend(env);
  if (search) catalogue.set('web_search', makeWebSearch(search));

  const picked = new Map<string, AgentTool>();
  const skipped: string[] = [];

  const take = (tool: AgentTool, explicit: boolean): void => {
    if (picked.has(tool.name)) return;
    if (tool.needsComputer && !hasComputer) {
      skipped.push(`${tool.name} (this husk has no computer)`);
      return;
    }
    if (tool.optIn && !explicit) {
      skipped.push(`${tool.name} (opt-in; name it explicitly to enable)`);
      return;
    }
    picked.set(tool.name, tool);
  };

  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;

    if (isBundle(name)) {
      for (const t of BUNDLES[name]()) take(t, true);
      // web_search rides along with the web bundle, but only when it can work.
      if (name === 'web') {
        const ws = catalogue.get('web_search');
        if (ws) take(ws, true);
        else skipped.push('web_search (no TAVILY_API_KEY or BRAVE_API_KEY)');
      }
      continue;
    }

    const tool = catalogue.get(name);
    if (!tool) {
      skipped.push(`${name} (no such tool)`);
      continue;
    }
    take(tool, true);
  }

  if (skipped.length) opts.logger?.debug(`tools not registered: ${skipped.join(', ')}`);
  return asTools([...picked.values()]);
}

/**
 * Everything `resolveTools` could ever return, for `husk doctor` and docs.
 *
 * The `browser` bundle was missing here while `resolveTools` registered it
 * fine, so `browse` and the Chromium tools worked and were invisible to every
 * surface that lists capabilities. The line above this one is the list that
 * gets edited when a bundle is added; this is the one that gets forgotten --
 * hence the test that asserts the two agree.
 */
export function listBuiltinTools(): AgentTool[] {
  return [
    ...computerTools,
    ...browserTools,
    ...realBrowserTools,
    ...fileTools,
    ...webTools,
    // `web_search` only registers when a search key is present, but this list
    // answers "what can husk do", not "what is switched on right now" -- a
    // capability nobody can discover is a capability nobody uses. The
    // placeholder credentials are never called: nothing here invokes a handler.
    makeWebSearch({ backend: 'tavily', key: '' }),
    ...httpTools,
  ];
}
