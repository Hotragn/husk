import type { HuskSpec, Logger, Tool } from '@husk/core';
import { asTools } from '../types.js';
import type { AgentTool } from '../types.js';
import { browserTools } from './browse.js';
import { computerTools } from './computer.js';
import { fileTools } from './files.js';
import { httpTools } from './http.js';
import { makeWebSearch, searchBackend, webTools } from './web.js';

export * from './browse.js';
export * from './computer.js';
export * from './files.js';
export * from './http.js';
export * from './web.js';

export const BUNDLES = {
  computer: () => computerTools,
  browser: () => browserTools,
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
  for (const t of [...computerTools, ...browserTools, ...fileTools, ...webTools, ...httpTools])
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

/** Everything resolveTools could ever return, for `husk doctor` and docs. */
export function listBuiltinTools(): AgentTool[] {
  return [...computerTools, ...fileTools, ...webTools, ...httpTools];
}
