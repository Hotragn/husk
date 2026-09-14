/**
 * The one `ModelRouter`.
 *
 * It answers four questions and nothing else: what is reachable right now
 * (`detect`), which model does this alias mean (`resolve`), can we afford it
 * (budget), and what do we do when the provider says no (fallback).
 *
 * Two rules shape the fallback behaviour. A downgrade is never silent — the caller
 * gets a `warning` event naming what failed and what replaced it, because a run that
 * quietly finished on an 8B local model when it asked for Opus is worse than a run
 * that failed. And a 400 is never retried anywhere: the request is malformed, and
 * shopping a malformed request around six providers just wastes six round trips.
 */

import type {
  ChatRequest,
  ChatResponse,
  Logger,
  ModelInfo,
  ModelProvider,
  StreamEvent,
} from '@husk-ai/core';
import { HuskError, createLogger, redact, retry, withTimeout } from '@husk-ai/core';
import { resolveAlias, type DynamicStrategy } from './aliases.js';
import { findModel, unknownModel, type CatalogModel } from './catalog.js';
import { costOf, formatUsd, minimumCostUsd } from './cost.js';
import { isAbort, isFatalRequestError, isRetryable } from './http.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { compatibleProviders } from './providers/compatible.js';
import { GoogleProvider } from './providers/google.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenAIProvider } from './providers/openai.js';
import type { FetchLike, ProviderOptions } from './providers/openai-compatible.js';
import { estimateMessages } from './tokens.js';

/**
 * A downgrade, a retry, or a budget skip, in the router's own vocabulary.
 *
 * This is the internal descriptor. What reaches the caller is the `warning` member of
 * `StreamEvent`, which `@husk-ai/core` now owns — `warningEvent()` below is the only
 * place the two shapes meet, and `from`/`to` land in `detail` so a consumer can tell
 * which model actually answered without parsing the message string.
 */
export interface ModelWarning {
  code: 'fallback' | 'retry' | 'budget_skip' | 'degraded';
  message: string;
  from?: string;
  to?: string;
}

/** The `warning` member of `StreamEvent`, narrowed. Defined by `@husk-ai/core`. */
export type ModelWarningEvent = Extract<StreamEvent, { type: 'warning' }>;

/**
 * Kept as an alias because callers import it, but it is now exactly `StreamEvent`:
 * the router has no event the core contract cannot express.
 */
export type RouterStreamEvent = StreamEvent;

/** `ChatRequest` plus the two things only a router can act on. */
export interface RouterRequest extends ChatRequest {
  /** Tried in order before the router's own preference list. Aliases are allowed. */
  fallbacks?: string[];
  /** Refuse the call when the prompt alone would cost more than this. */
  maxCostUsd?: number;
}

export interface ProviderStatus {
  id: string;
  displayName: string;
  available: boolean;
  reason?: string;
  hint?: string;
  /** How many models this provider can serve right now. */
  models: number;
  /** True when at least one of those models costs nothing. */
  free: boolean;
  priority: number;
}

export interface DetectReport {
  checkedAt: number;
  providers: ProviderStatus[];
  /** Ids of the providers that are usable. */
  available: string[];
  /** What `auto` would choose right now, fully qualified. */
  recommended?: string;
  /** What `free` would choose right now, fully qualified. */
  cheapest?: string;
  /** Ordered, most actionable first. `husk doctor` prints these verbatim. */
  hints: string[];
}

export interface ModelRouterOptions {
  /** Replaces the default registry entirely. Used by tests and by embedders. */
  providers?: ModelProvider[];
  /** User alias overrides, i.e. `HuskConfig.modelAliases`. */
  aliases?: Record<string, string>;
  /** Global spend ceiling for a single call. `HuskConfig.maxCostUsd`. */
  maxCostUsd?: number;
  /** How long a `detect()` answer stays fresh. */
  detectTtlMs?: number;
  /** Attempts per candidate, including the first. */
  attempts?: number;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  logger?: Logger;
}

/** A provider paired with one concrete model it can serve. */
export interface Candidate {
  provider: ModelProvider;
  /** Fully qualified `provider/model`. */
  id: string;
  info: ModelInfo;
}

const DETECT_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 3_000;

export class ModelRouter {
  private readonly registry = new Map<string, ModelProvider>();
  private readonly aliases: Record<string, string>;
  private readonly maxCostUsd: number | undefined;
  private readonly ttl: number;
  private readonly attempts: number;
  private readonly log: Logger;
  private cached: DetectReport | undefined;
  private inFlight: Promise<DetectReport> | undefined;
  private readonly modelsByProvider = new Map<string, ModelInfo[]>();

  constructor(opts: ModelRouterOptions = {}) {
    this.aliases = opts.aliases ?? {};
    this.maxCostUsd = opts.maxCostUsd;
    this.ttl = opts.detectTtlMs ?? DETECT_TTL_MS;
    this.attempts = Math.max(1, opts.attempts ?? 3);
    this.log = opts.logger ?? createLogger({ scope: 'models' });

    const providerOpts: ProviderOptions = {
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    };
    const providers = opts.providers ?? defaultProviders(providerOpts);
    for (const p of providers) this.register(p);
  }

  register(provider: ModelProvider): void {
    this.registry.set(provider.id, provider);
    this.cached = undefined;
  }

  get providers(): ModelProvider[] {
    return [...this.registry.values()];
  }

  /**
   * Which providers are usable right now, cached for `detectTtlMs`.
   *
   * Never throws: a provider that hangs or explodes is reported as unavailable with
   * the reason, because the entire point of this call is to render `husk doctor`.
   */
  async detect(opts: { force?: boolean } = {}): Promise<DetectReport> {
    const fresh = this.cached && Date.now() - this.cached.checkedAt < this.ttl;
    if (fresh && !opts.force) return this.cached!;
    if (this.inFlight && !opts.force) return this.inFlight;

    this.inFlight = this.probeAll().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async probeAll(): Promise<DetectReport> {
    const statuses = await Promise.all(this.providers.map((p) => this.probe(p)));
    statuses.sort((a, b) => b.priority - a.priority);

    const available = statuses.filter((s) => s.available).map((s) => s.id);
    const report: DetectReport = {
      checkedAt: Date.now(),
      providers: statuses,
      available,
      hints: [],
    };

    const auto = this.pickFrom('auto', available);
    const free = this.pickFrom('free', available);
    if (auto) report.recommended = auto.id;
    if (free) report.cheapest = free.id;
    report.hints = buildHints(statuses);

    this.cached = report;
    return report;
  }

  private async probe(provider: ModelProvider): Promise<ProviderStatus> {
    const base = { id: provider.id, displayName: provider.displayName, priority: provider.priority };
    let availability: { available: boolean; reason?: string; hint?: string };
    try {
      availability = await withTimeout(provider.isAvailable(), PROBE_TIMEOUT_MS, 'probe timed out');
    } catch (err) {
      return {
        ...base,
        available: false,
        reason: redact(err instanceof Error ? err.message : String(err)),
        hint: `Could not reach ${provider.displayName}.`,
        models: 0,
        free: false,
      };
    }

    if (!availability.available) {
      this.modelsByProvider.delete(provider.id);
      return {
        ...base,
        available: false,
        ...(availability.reason ? { reason: redact(availability.reason) } : {}),
        ...(availability.hint ? { hint: availability.hint } : {}),
        models: 0,
        free: false,
      };
    }

    let models: ModelInfo[] = [];
    try {
      models = await withTimeout(provider.listModels(), PROBE_TIMEOUT_MS, 'listing timed out');
    } catch (err) {
      this.log.debug(`${provider.id}: could not list models`, { error: String(err) });
    }
    this.modelsByProvider.set(provider.id, models);

    return {
      ...base,
      available: models.length > 0,
      ...(models.length === 0 ? { reason: 'no models available', hint: `Configure a model for ${provider.displayName}.` } : {}),
      models: models.length,
      free: models.some((m) => m.free === true),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    await this.detect();
    const out: ModelInfo[] = [];
    for (const models of this.modelsByProvider.values()) out.push(...models);
    return out;
  }

  /** `RouterLike.getModelInfo`. Null when nothing knows about this id. */
  async getModelInfo(model: string): Promise<ModelInfo | null> {
    let resolution;
    try {
      resolution = resolveAlias(model, this.aliases);
    } catch {
      return null;
    }
    if (resolution.kind === 'dynamic') {
      await this.detect();
      const pick = this.pickFrom(resolution.strategy, this.cached?.available ?? []);
      return pick?.info ?? null;
    }
    const known = findModel(resolution.id);
    if (known) return known;
    const live = this.modelsByProvider.get(resolution.provider) ?? [];
    return live.find((m) => m.id === resolution.id) ?? null;
  }

  /**
   * Which provider serves this model, and what we know about it.
   *
   * Unlike the version this replaced, `auto` considers every configured provider —
   * an `ANTHROPIC_API_KEY` in the environment is exactly as much of a signal as a
   * running Ollama, and quite a lot more expensive to ignore.
   */
  async resolveProvider(model: string): Promise<Candidate> {
    const first = (await this.candidates({ model, messages: [] }))[0];
    if (!first) throw this.nothingAvailable(model);
    return first;
  }

  async chat(req: RouterRequest): Promise<ChatResponse> {
    const candidates = await this.candidates(req);
    let lastError: unknown;

    // A log line is not a warning the caller can see. `stream()` emits a
    // `warning` event when it falls back; the single-shot path has to carry the
    // same information on the response, or asking for Opus and being answered
    // by a 1.5B local model is an ordinary-looking 200.
    const warnings: NonNullable<ChatResponse['warnings']> = [];

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      try {
        const response = await this.attempt(candidate, req, (w) => {
          this.log.warn(w.message);
          // ModelWarning carries from/to as flat fields; ChatResponse.warnings
          // nests them under `detail`, so a consumer can act on the pair.
          const detail = w.from !== undefined || w.to !== undefined ? { from: w.from, to: w.to } : undefined;
          warnings.push({ message: w.message, code: w.code, ...(detail ? { detail } : {}) });
        });
        const priced = this.priced(response, candidate);
        if (i > 0) {
          const asked = candidates[0]!.id;
          warnings.unshift({
            message: `${asked} was unavailable, so this answer came from ${candidate.id}`,
            code: 'fallback',
            detail: { from: asked, to: candidate.id },
          });
        }
        return warnings.length > 0 ? { ...priced, warnings } : priced;
      } catch (err) {
        lastError = err;
        if (isAbort(err) || isFatalRequestError(err)) throw err;
        const next = candidates[i + 1];
        if (!next) break;
        this.log.warn(fallbackMessage(candidate.id, next.id, err));
      }
    }

    throw this.exhausted(req, candidates, lastError);
  }

  /**
   * A real stream: `text_delta` is yielded as the bytes arrive, never after.
   *
   * A candidate can only be abandoned before it has produced content. Once a token
   * has reached the caller there is nothing honest to do with a mid-stream failure
   * except report it, so that case ends in an `error` event rather than a silent
   * restart on a different model.
   */
  async *stream(req: RouterRequest): AsyncIterable<RouterStreamEvent> {
    let candidates: Candidate[];
    try {
      candidates = await this.candidates(req);
    } catch (err) {
      yield errorEvent(err);
      return;
    }

    let lastError: unknown;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      let produced = false;
      let opened: { first: StreamEvent; rest: AsyncIterator<StreamEvent> } | undefined;

      try {
        opened = await retry((attempt) => this.open(candidate, req, attempt), {
          attempts: this.attempts,
          baseMs: 400,
          maxMs: 8_000,
          ...(req.signal ? { signal: req.signal } : {}),
          shouldRetry: (err) => this.shouldRetrySame(err),
          onRetry: (err, attempt, delay) =>
            this.log.debug(`${candidate.id}: retry ${attempt} in ${delay}ms`, { error: String(err) }),
        });
      } catch (err) {
        lastError = normaliseAborted(err, req);
        if (isAbort(lastError) || isFatalRequestError(lastError)) break;
        const next = candidates[i + 1];
        if (!next) break;
        yield warningEvent({
          code: 'fallback',
          message: fallbackMessage(candidate.id, next.id, lastError),
          from: candidate.id,
          to: next.id,
        });
        continue;
      }

      try {
        yield opened.first;
        for (;;) {
          const step = await opened.rest.next();
          if (step.done) break;
          const event = step.value;
          if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'tool_call') {
            produced = true;
          }
          if (event.type === 'done') {
            yield { type: 'done', response: this.priced(event.response, candidate) };
            return;
          }
          yield event;
        }
        return;
      } catch (err) {
        lastError = normaliseAborted(err, req);
        await quietReturn(opened.rest);
        if (produced || isAbort(lastError) || isFatalRequestError(lastError)) break;
        const next = candidates[i + 1];
        if (!next) break;
        yield warningEvent({
          code: 'fallback',
          message: fallbackMessage(candidate.id, next.id, lastError),
          from: candidate.id,
          to: next.id,
        });
      }
    }

    yield errorEvent(this.exhausted(req, candidates, lastError));
  }

  /** Open a stream and pull its first event, so a setup failure is throwable. */
  private async open(
    candidate: Candidate,
    req: RouterRequest,
    attempt: number,
  ): Promise<{ first: StreamEvent; rest: AsyncIterator<StreamEvent> }> {
    if (attempt > 1) this.log.debug(`${candidate.id}: reopening stream (attempt ${attempt})`);
    const iterator = candidate.provider.stream({ ...req, model: candidate.id })[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) {
      return { first: { type: 'start', model: candidate.id }, rest: emptyIterator() };
    }
    return { first: first.value, rest: iterator };
  }

  private async attempt(
    candidate: Candidate,
    req: RouterRequest,
    onWarn: (w: ModelWarning) => void,
  ): Promise<ChatResponse> {
    try {
      return await retry(() => candidate.provider.chat({ ...req, model: candidate.id }), {
        attempts: this.attempts,
        baseMs: 400,
        maxMs: 8_000,
        ...(req.signal ? { signal: req.signal } : {}),
        shouldRetry: (err) => this.shouldRetrySame(err),
        onRetry: (err, attempt, delay) => {
          onWarn({
            code: 'retry',
            message: `${candidate.id} failed (${describe(err)}); retry ${attempt} in ${delay}ms`,
            from: candidate.id,
          });
        },
      });
    } catch (err) {
      throw normaliseAborted(err, req);
    }
  }

  /** A 400 is our bug, a 401 is a configuration problem; neither improves on retry. */
  private shouldRetrySame(err: unknown): boolean {
    if (isAbort(err) || isFatalRequestError(err)) return false;
    if (err instanceof HuskError && err.code === 'E_NO_CREDENTIALS') return false;
    if (err instanceof HuskError && err.code === 'E_BUDGET_EXCEEDED') return false;
    return isRetryable(err);
  }

  /** Fill in `costUsd` for providers that could not, and warn on an overspend. */
  private priced(response: ChatResponse, candidate: Candidate): ChatResponse {
    const usage = { ...response.usage };
    if (usage.costUsd === undefined) usage.costUsd = costOf(candidate.info, usage);
    const limit = this.maxCostUsd;
    if (limit !== undefined && usage.costUsd > limit) {
      this.log.warn(
        `${candidate.id} cost ${formatUsd(usage.costUsd)}, over the ${formatUsd(limit)} ceiling; the estimate was low`,
      );
    }
    return { ...response, model: candidate.id, usage };
  }

  /**
   * The ordered list of models to try: the requested one, then the caller's explicit
   * fallbacks, then whatever the preference order turns up.
   */
  private async candidates(req: RouterRequest): Promise<Candidate[]> {
    const resolution = resolveAlias(req.model, this.aliases);
    const report = await this.detect();
    const limit = req.maxCostUsd ?? this.maxCostUsd;
    const inputTokens = estimateMessages(req.messages, req.tools, req.system);

    const out: Candidate[] = [];
    const seen = new Set<string>();
    const add = (candidate: Candidate | undefined) => {
      if (!candidate || seen.has(candidate.id)) return;
      seen.add(candidate.id);
      out.push(candidate);
    };

    let strategy: DynamicStrategy = 'auto';
    if (resolution.kind === 'dynamic') {
      strategy = resolution.strategy;
    } else {
      const explicit = this.candidateFor(resolution.id);
      if (!explicit) throw this.unknownProvider(resolution.id, report);
      // An explicitly named model is never quietly swapped for a cheaper one.
      this.assertAffordable(explicit, inputTokens, limit);
      add(explicit);
    }

    for (const fallback of req.fallbacks ?? []) {
      try {
        const resolved = resolveAlias(fallback, this.aliases);
        if (resolved.kind === 'dynamic') {
          add(this.pickFrom(resolved.strategy, report.available, seen, inputTokens, limit));
        } else {
          const candidate = this.candidateFor(resolved.id);
          if (candidate && this.affordable(candidate, inputTokens, limit)) add(candidate);
        }
      } catch (err) {
        this.log.debug(`ignoring unusable fallback "${fallback}"`, { error: String(err) });
      }
    }

    for (const candidate of this.orderedFor(strategy, report.available, inputTokens, limit)) add(candidate);

    if (out.length === 0) {
      if (this.orderedFor(strategy, report.available).length > 0) {
        throw this.budgetExceeded(strategy, inputTokens, limit, report);
      }
      throw this.nothingAvailable(req.model);
    }
    return out;
  }

  private candidateFor(id: string): Candidate | undefined {
    const slash = id.indexOf('/');
    if (slash <= 0) return undefined;
    const providerId = id.slice(0, slash);
    const name = id.slice(slash + 1);
    const provider = this.registry.get(providerId);
    if (!provider) return undefined;
    const live = this.modelsByProvider.get(providerId) ?? [];
    const info = live.find((m) => m.id === id) ?? findModel(id) ?? unknownModel(providerId, name, false);
    return { provider, id, info };
  }

  private pickFrom(
    strategy: DynamicStrategy,
    available: string[],
    exclude?: Set<string>,
    inputTokens = 0,
    limit?: number,
  ): Candidate | undefined {
    for (const candidate of this.orderedFor(strategy, available, inputTokens, limit)) {
      if (!exclude?.has(candidate.id)) return candidate;
    }
    return undefined;
  }

  /**
   * `auto` wants the best model that works; `free` and `local` want the cheapest.
   * Both fall back to the other ordering once their own pool is exhausted, so a
   * `free` request on a machine with only a paid key still runs — noisily.
   */
  private orderedFor(
    strategy: DynamicStrategy,
    available: string[],
    inputTokens = 0,
    limit?: number,
  ): Candidate[] {
    const pool: Candidate[] = [];
    for (const providerId of available) {
      const provider = this.registry.get(providerId);
      if (!provider) continue;
      for (const info of this.modelsByProvider.get(providerId) ?? []) {
        if (strategy === 'local' && providerId !== 'ollama' && providerId !== 'lmstudio') continue;
        pool.push({ provider, id: info.id, info });
      }
    }

    const affordable = pool.filter((c) => this.affordable(c, inputTokens, limit));
    const byQuality = (a: Candidate, b: Candidate) => qualityOf(b.info) - qualityOf(a.info);
    const byCost = (a: Candidate, b: Candidate) => inputPrice(a.info) - inputPrice(b.info);

    if (strategy === 'auto') {
      return affordable.sort((a, b) => byQuality(a, b) || byCost(a, b));
    }
    return affordable.sort((a, b) => {
      const aFree = a.info.free === true ? 0 : 1;
      const bFree = b.info.free === true ? 0 : 1;
      return aFree - bFree || byCost(a, b) || byQuality(a, b);
    });
  }

  private affordable(candidate: Candidate, inputTokens: number, limit: number | undefined): boolean {
    if (limit === undefined) return true;
    return minimumCostUsd(candidate.info, inputTokens) <= limit;
  }

  private assertAffordable(candidate: Candidate, inputTokens: number, limit: number | undefined): void {
    if (this.affordable(candidate, inputTokens, limit)) return;
    const floor = minimumCostUsd(candidate.info, inputTokens);
    throw new HuskError(
      'E_BUDGET_EXCEEDED',
      `${candidate.id} would cost at least ${formatUsd(floor)} for this prompt, over the ${formatUsd(limit!)} limit`,
      {
        hint: `Raise maxCostUsd, shorten the prompt (~${inputTokens} tokens), or use a free model: \`--model free\`.`,
        details: { model: candidate.id, minCostUsd: floor, maxCostUsd: limit, inputTokens },
      },
    );
  }

  private budgetExceeded(
    strategy: DynamicStrategy,
    inputTokens: number,
    limit: number | undefined,
    report: DetectReport,
  ): HuskError {
    return new HuskError(
      'E_BUDGET_EXCEEDED',
      `no ${strategy} model can serve a ~${inputTokens} token prompt for under ${formatUsd(limit ?? 0)}`,
      {
        hint: report.cheapest
          ? `Raise maxCostUsd, or use \`--model ${report.cheapest}\`.`
          : 'Raise maxCostUsd, or run `ollama pull qwen2.5:7b` for a model that costs nothing.',
        details: { inputTokens, maxCostUsd: limit },
      },
    );
  }

  private unknownProvider(id: string, report: DetectReport): HuskError {
    const providerId = id.slice(0, Math.max(0, id.indexOf('/')));
    const known = [...this.registry.keys()].join(', ');
    if (!this.registry.has(providerId)) {
      return new HuskError('E_MODEL_UNAVAILABLE', `No provider named "${providerId}"`, {
        hint: `Known providers: ${known}.`,
        details: { model: id },
      });
    }
    const status = report.providers.find((p) => p.id === providerId);
    return new HuskError('E_PROVIDER_UNAVAILABLE', `${providerId} cannot serve "${id}"`, {
      hint: status?.hint ?? `Configure ${providerId} first.`,
      details: { model: id },
    });
  }

  private nothingAvailable(model: string): HuskError {
    const hints = this.cached?.hints ?? [];
    return new HuskError('E_MODEL_UNAVAILABLE', `No provider can serve "${model}"`, {
      hint: hints[0] ?? 'Run `ollama pull qwen2.5:7b` for a free local model, or set ANTHROPIC_API_KEY.',
      details: { model, hints },
    });
  }

  private exhausted(req: RouterRequest, candidates: Candidate[], lastError: unknown): HuskError {
    if (lastError instanceof HuskError) {
      if (candidates.length <= 1) return lastError;
      return new HuskError(lastError.code, `all ${candidates.length} candidates failed; last: ${lastError.message}`, {
        hint: lastError.hint ?? 'Run `husk doctor` to see which providers are reachable.',
        details: { tried: candidates.map((c) => c.id), requested: req.model },
        cause: lastError,
      });
    }
    if (lastError !== undefined) {
      return new HuskError('E_MODEL_ERROR', `all candidates failed: ${redact(describe(lastError))}`, {
        hint: 'Run `husk doctor` to see which providers are reachable.',
        details: { tried: candidates.map((c) => c.id), requested: req.model },
        cause: lastError,
      });
    }
    return this.nothingAvailable(req.model);
  }
}

export function defaultProviders(opts: ProviderOptions = {}): ModelProvider[] {
  return [
    new AnthropicProvider(opts),
    new OpenAIProvider(opts),
    new GoogleProvider(opts),
    ...compatibleProviders(opts),
    new OllamaProvider(opts),
  ];
}

function qualityOf(info: ModelInfo): number {
  const quality = (info as CatalogModel).quality;
  if (typeof quality === 'number') return quality;
  return info.free === true ? 40 : 50;
}

function inputPrice(info: ModelInfo): number {
  return info.pricing?.inputPerMTok ?? 0;
}

function describe(err: unknown): string {
  if (err instanceof HuskError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function fallbackMessage(from: string, to: string, err: unknown): string {
  return redact(`${from} failed (${describe(err)}); falling back to ${to}`);
}

/**
 * The router's internal warning, in the shape `@husk-ai/core` defines.
 *
 * `from` and `to` go in `detail` rather than only in the prose so a caller can act on
 * a downgrade — re-prompt, annotate the transcript, abort — without regex-ing an
 * English sentence that is free to change.
 */
function warningEvent(w: ModelWarning): ModelWarningEvent {
  const detail: Record<string, unknown> = {};
  if (w.from !== undefined) detail.from = w.from;
  if (w.to !== undefined) detail.to = w.to;
  return {
    type: 'warning',
    message: w.message,
    code: w.code,
    ...(Object.keys(detail).length > 0 ? { detail } : {}),
  };
}

function errorEvent(err: unknown): StreamEvent {
  const huskError = err instanceof HuskError ? err : undefined;
  const message = redact(describe(err));
  return {
    type: 'error',
    error: {
      message: huskError?.hint ? `${message} — ${huskError.hint}` : message,
      ...(huskError ? { code: huskError.code } : {}),
      retryable: isRetryable(err),
    },
  };
}

/** `retry()` rejects with a bare `Error('aborted')` when its signal fires. */
function normaliseAborted(err: unknown, req: RouterRequest): unknown {
  if (err instanceof HuskError) return err;
  if (req.signal?.aborted) {
    return new HuskError('E_ABORTED', 'request aborted', {
      hint: 'The caller cancelled this request.',
      details: { retryable: false },
      cause: err,
    });
  }
  return err;
}

async function quietReturn(iterator: AsyncIterator<StreamEvent>): Promise<void> {
  try {
    await iterator.return?.(undefined);
  } catch {
    // Closing a stream that already failed is allowed to fail too.
  }
}

function emptyIterator(): AsyncIterator<StreamEvent> {
  return {
    async next() {
      return { done: true, value: undefined };
    },
  };
}

/**
 * The hints `husk doctor` shows. Ordered cheapest-real-path first: a user with
 * nothing configured should be told how to get running for free before being told
 * about six services that want a credit card.
 */
function buildHints(statuses: ProviderStatus[]): string[] {
  const hints: string[] = [];
  const usable = statuses.filter((s) => s.available);
  const ollama = statuses.find((s) => s.id === 'ollama');

  if (usable.length === 0) {
    hints.push(
      'Nothing is configured yet. Cheapest path: install Ollama from https://ollama.com, then `ollama pull qwen2.5:7b` -- free, local, no account, and Husk works immediately.',
    );
    hints.push(
      'Free hosted alternatives: GOOGLE_API_KEY (aistudio.google.com, Gemini Flash free tier) or GROQ_API_KEY (console.groq.com).',
    );
    hints.push('For the best quality, set ANTHROPIC_API_KEY and use `--model sonnet`.');
  } else if (!usable.some((s) => s.free)) {
    hints.push(
      'Every configured provider bills per token. `ollama pull qwen2.5:7b` adds a free local fallback so a rate limit or a spend cap does not stop a run.',
    );
  }

  if (ollama && !ollama.available && ollama.hint && usable.length > 0) hints.push(ollama.hint);

  for (const status of statuses) {
    if (status.available || !status.hint) continue;
    if (usable.length === 0 && (status.id === 'ollama' || status.id === 'google' || status.id === 'groq' || status.id === 'anthropic')) {
      continue; // already covered by the headline hints above
    }
    hints.push(`${status.displayName}: ${status.hint}`);
  }

  return hints;
}
