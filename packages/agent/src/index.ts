/**
 * @husk-ai/agent -- the tool-calling loop and the built-in tools.
 *
 * Depends on @husk-ai/core only. The model router and the computer source are
 * injected as structural interfaces, so the loop runs in a test with no network,
 * no Docker, and no build-order coupling to the packages that provide them.
 */

export { Agent, buildAssistantMessage, computerSpecFor, stableArgs } from './loop.js';
export { Budget, pricingOf } from './budget.js';
export type { BudgetDecision, BudgetLimits, BudgetStop, CallEstimate, Pricing } from './budget.js';

export { trimHistory, pruneOrphans, renderForSummary } from './memory.js';
export type { TrimOptions, TrimResult } from './memory.js';

export { evaluateCommand, assertCommandAllowed } from './guard.js';
export type { CommandDecision } from './guard.js';

export { hostMatches, isHostAllowed, isPrivateHost, urlHost, assertUrlAllowed } from './net.js';
export { htmlToText, decodeEntities, extractTitle, looksLikeHtml } from './html.js';
export { EventQueue } from './queue.js';

export {
  resolveTools,
  listBuiltinTools,
  isBundle,
  BUNDLES,
  computerTools,
  fileTools,
  webTools,
  httpTools,
  shell,
  expose_port,
  computer_info,
  read_file,
  write_file,
  edit_file,
  list_dir,
  search_files,
  move,
  remove,
  fetch_url,
  http_request,
  makeWebSearch,
  searchBackend,
  globToRegExp,
} from './tools/index.js';
export type { BundleName, ResolveToolsOptions } from './tools/index.js';
export type { ReadFileResult, SearchHit } from './tools/files.js';
export type { ShellResult } from './tools/computer.js';
export type { FetchUrlResult, SearchBackend, SearchResult } from './tools/web.js';
export type { HttpResult } from './tools/http.js';

export { defineTool, asTools } from './types.js';
export type {
  AgentOptions,
  AgentRunEvent,
  AgentRunOptions,
  AgentTool,
  AgentToolContext,
  ApprovalRequest,
  Approver,
  ComputerSource,
  RouterLike,
  ToolDeltaEvent,
} from './types.js';
