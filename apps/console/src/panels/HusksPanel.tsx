/**
 * Husks: the list, the YAML, validation, and a playground that runs one.
 *
 * The playground streams `POST /v1/husks/:name/run/stream` and renders the
 * `RunEvent` union from `@husk/core` as it arrives — `text_delta`,
 * `tool_start`, `tool_delta`, `tool_end`, `usage` and the rest. When the run
 * blocks on `approval_required` the panel actually prompts and POSTs the answer
 * to `/v1/approvals/:id`; an unanswered request is denied by the server after
 * 120 seconds, and the countdown here is that real deadline.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnection } from '../state/connection';
import { useResource } from '../state/useResource';
import { isAbort, toDisplayError } from '../api/client';
import type { DisplayError } from '../api/client';
import type {
  HuskDetail,
  HuskSummary,
  ModelListResponse,
  RunEvent,
  RunRequestBody,
  RunStreamEvent,
  ValidateResult,
} from '../api/wire';
import {
  Badge,
  Button,
  EmptyState,
  ErrorBlock,
  Field,
  PanelHeader,
  Skeleton,
  StatusLine,
  formatWhen,
} from '../components/primitives';

const APPROVAL_TIMEOUT_MS = 120_000;

export function HusksPanel() {
  const { api, revision } = useConnection();
  const husks = useResource<HuskSummary[]>((signal) => api.listHusks(signal), [api, revision]);
  const [selected, setSelected] = useState<string | null>(null);

  const rows = husks.data ?? [];

  useEffect(() => {
    if (selected === null && rows.length > 0) setSelected(rows[0]?.name ?? null);
    if (selected !== null && rows.length > 0 && !rows.some((h) => h.name === selected)) {
      setSelected(rows[0]?.name ?? null);
    }
  }, [rows, selected]);

  return (
    <section className="panel" aria-labelledby="husks-title">
      <PanelHeader
        title="Husks"
        lede="Agents defined by a husk.yaml on disk. GET /v1/husks."
        actions={<Button onClick={husks.reload}>Refresh</Button>}
      />
      <span id="husks-title" className="visually-hidden">
        Husks
      </span>

      {husks.error ? <ErrorBlock error={husks.error} retry={husks.reload} /> : null}
      {!husks.data && husks.loading && husks.slow ? <StatusLine text="Reading ~/.husk/husks…" /> : null}
      {!husks.data && husks.showSkeleton && !husks.slow ? <Skeleton rows={4} /> : null}

      {husks.data && rows.length === 0 ? (
        <EmptyState
          title="No husks yet."
          body="A husk is a YAML file describing one agent. Distil one from a chat transcript, or write it by hand and POST it."
          command="husk init ci-triage"
        />
      ) : null}

      {rows.length > 0 ? (
        <>
          <div className="table-scroll">
            <table className="data">
              <caption>{rows.length} husk{rows.length === 1 ? '' : 's'}. Select one to see its YAML.</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Model</th>
                  <th scope="col">Tools</th>
                  <th scope="col">Triggers</th>
                  <th scope="col">Computer</th>
                  <th scope="col">Runs</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => (
                  <tr
                    key={h.name}
                    className="selectable"
                    aria-selected={h.name === selected}
                    tabIndex={0}
                    onClick={() => setSelected(h.name)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelected(h.name);
                      }
                    }}
                  >
                    <td className="mono">
                      {h.name}
                      {h.displayName !== h.name ? <span className="field-note"> · {h.displayName}</span> : null}
                    </td>
                    <td className="mono">{h.model}</td>
                    <td className="mono">{h.tools.join(', ') || '—'}</td>
                    <td className="mono">{h.triggers.join(', ') || '—'}</td>
                    <td>{h.computer.enabled ? <Badge>{h.computer.flavor}</Badge> : <Badge>off</Badge>}</td>
                    <td className="mono tnum">{h.runCount}</td>
                    <td className="mono tnum">{formatWhen(h.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selected ? <HuskDetailView name={selected} onSaved={husks.reload} /> : null}
        </>
      ) : null}
    </section>
  );
}

// -----------------------------------------------------------------------------
// YAML + validation
// -----------------------------------------------------------------------------

function HuskDetailView({ name, onSaved }: { name: string; onSaved: () => void }) {
  const { api, revision } = useConnection();
  const detail = useResource<HuskDetail>((signal) => api.getHusk(name, signal), [api, name, revision]);

  const [yaml, setYaml] = useState('');
  const [validation, setValidation] = useState<ValidateResult | null>(null);
  const [busy, setBusy] = useState<'validating' | 'saving' | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setYaml(detail.data?.yaml ?? '');
    setValidation(null);
    setError(null);
    setSaved(false);
  }, [detail.data]);

  const dirty = detail.data !== null && yaml !== detail.data.yaml;

  const validate = useCallback(async () => {
    setBusy('validating');
    setError(null);
    setSaved(false);
    try {
      setValidation(await api.validateHusk(yaml));
    } catch (err) {
      setError(toDisplayError(err));
    } finally {
      setBusy(null);
    }
  }, [api, yaml]);

  const save = useCallback(async () => {
    setBusy('saving');
    setError(null);
    try {
      await api.saveHusk(name, yaml);
      setSaved(true);
      onSaved();
      detail.reload();
    } catch (err) {
      setError(toDisplayError(err));
    } finally {
      setBusy(null);
    }
  }, [api, detail, name, onSaved, yaml]);

  return (
    <div className="section split-wide">
      <div>
        <h2>{name}</h2>
        <p className="hint">
          The file on disk, from <code>GET /v1/husks/{name}</code>. Edit it and validate before saving — validation is
          the server's parser, not a client-side guess.
        </p>

        {detail.error ? <ErrorBlock error={detail.error} retry={detail.reload} /> : null}
        {!detail.data && detail.showSkeleton ? <Skeleton rows={8} height={24} /> : null}

        {detail.data ? (
          <>
            <label className="visually-hidden" htmlFor="husk-yaml">
              husk.yaml for {name}
            </label>
            <textarea
              id="husk-yaml"
              className="textarea mono"
              style={{ minHeight: '26rem', marginTop: 'var(--space-3)' }}
              spellCheck={false}
              value={yaml}
              aria-invalid={validation?.ok === false || undefined}
              aria-describedby={validation?.ok === false ? 'husk-yaml-issues' : undefined}
              onChange={(e) => {
                setYaml(e.target.value);
                setValidation(null);
                setSaved(false);
              }}
            />
            <div className="btn-row" style={{ marginTop: 'var(--space-3)' }}>
              <Button onClick={() => void validate()} loading={busy === 'validating'}>
                Validate
              </Button>
              <Button
                variant="primary"
                onClick={() => void save()}
                loading={busy === 'saving'}
                disabled={!dirty || validation?.ok === false}
              >
                Save
              </Button>
              <Button variant="ghost" onClick={() => setYaml(detail.data?.yaml ?? '')} disabled={!dirty}>
                Revert
              </Button>
              {dirty ? <Badge tone="info">unsaved</Badge> : null}
            </div>

            {validation?.ok === true ? (
              <p className="hint" role="status">
                Valid. <code>POST /v1/husks/validate</code> returned <code>{'{ "ok": true }'}</code>.
              </p>
            ) : null}
            {validation?.ok === false ? (
              <div id="husk-yaml-issues" className="error-block" role="alert" style={{ marginTop: 'var(--space-3)' }}>
                <span className="code">E_SPEC_INVALID</span>
                <p className="message">
                  {validation.issues.length} issue{validation.issues.length === 1 ? '' : 's'}, verbatim from the
                  server's parser:
                </p>
                <ul className="list-plain" style={{ marginTop: 'var(--space-2)' }}>
                  {validation.issues.map((issue) => (
                    <li key={issue} className="mono" style={{ color: 'var(--color-text)' }}>
                      {issue}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {saved ? (
              <p className="hint" role="status">
                Saved.
              </p>
            ) : null}
            {error ? <ErrorBlock error={error} /> : null}
          </>
        ) : null}
      </div>

      <Playground name={name} />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Playground
// -----------------------------------------------------------------------------

interface ToolItem {
  kind: 'tool';
  id: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  output: string;
  stream: string;
  done: boolean;
  isError: boolean;
  durationMs?: number;
  denied?: string;
}

interface TextItem {
  kind: 'text' | 'thinking' | 'note' | 'warning';
  id: string;
  text: string;
}

type StreamItem = ToolItem | TextItem;

interface PendingApproval {
  approvalId: string;
  tool?: string;
  prompt: string;
  args?: Record<string, unknown>;
  askedAt: number;
}

export function Playground({ name }: { name: string }) {
  const { api, revision } = useConnection();
  const models = useResource<ModelListResponse>((signal) => api.listModels(signal), [api, revision]);

  const [input, setInput] = useState('');
  const [model, setModel] = useState('');
  const [approvalMode, setApprovalMode] = useState<'auto' | 'ask' | 'readonly'>('ask');
  const [maxSteps, setMaxSteps] = useState('6');

  const [items, setItems] = useState<StreamItem[]>([]);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ inputTokens: number; outputTokens: number; costUsd?: number } | null>(null);
  const [finished, setFinished] = useState<{ stopReason: string; durationMs: number; steps: number } | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [approvalError, setApprovalError] = useState<DisplayError | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const abortRef = useRef<AbortController | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const pendingText = useRef('');

  useEffect(() => () => abortRef.current?.abort(), []);

  // The approval deadline is the server's real 120s timeout, not decoration.
  useEffect(() => {
    if (!approval) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [approval]);

  // Keep the transcript pinned to the bottom only when the reader is already there.
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [items]);

  const appendText = useCallback((kind: TextItem['kind'], text: string) => {
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === kind) {
        const updated: TextItem = { ...(last as TextItem), text: (last as TextItem).text + text };
        return [...prev.slice(0, -1), updated];
      }
      return [...prev, { kind, id: `${kind}-${prev.length}`, text }];
    });
  }, []);

  const flushText = useCallback(() => {
    if (pendingText.current) {
      const buffered = pendingText.current;
      pendingText.current = '';
      appendText('text', buffered);
    }
  }, [appendText]);

  const handleEvent = useCallback(
    (event: RunEvent) => {
      switch (event.type) {
        case 'run_start':
          setRunId(event.runId);
          appendText('note', `run ${event.runId} · ${event.husk} · ${event.model}`);
          break;
        case 'step_start':
          flushText();
          break;
        case 'text_delta':
          // Reduced motion: no character-by-character arrival. The tokens are
          // buffered and rendered in complete chunks at the next boundary.
          if (reducedMotion) pendingText.current += event.text;
          else appendText('text', event.text);
          break;
        case 'thinking_delta':
          appendText('thinking', event.text);
          break;
        case 'tool_start':
          flushText();
          setItems((prev) => [
            ...prev,
            {
              kind: 'tool',
              id: `tool-${event.call.id}`,
              callId: event.call.id,
              name: event.call.name,
              args: event.call.args,
              output: '',
              stream: '',
              done: false,
              isError: false,
            },
          ]);
          break;
        case 'tool_delta':
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'tool' && it.callId === event.callId ? { ...it, stream: it.stream + event.text } : it,
            ),
          );
          break;
        case 'tool_end':
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'tool' && it.callId === event.call.id
                ? { ...it, done: true, output: event.output, isError: event.isError, durationMs: event.durationMs }
                : it,
            ),
          );
          break;
        case 'tool_denied':
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'tool' && it.callId === event.call.id ? { ...it, done: true, denied: event.reason } : it,
            ),
          );
          break;
        case 'approval_required':
          flushText();
          setApproval({
            approvalId: event.approvalId,
            ...(event.request.tool ? { tool: event.request.tool } : {}),
            prompt: event.request.prompt,
            ...(event.request.args ? { args: event.request.args } : {}),
            askedAt: Date.now(),
          });
          setNow(Date.now());
          break;
        case 'computer_ready':
          appendText('note', `computer ${event.computerId} ready on ${event.provider}`);
          break;
        case 'usage':
          setUsage(event.cumulative);
          break;
        case 'warning':
          appendText('warning', event.message);
          break;
        case 'message':
          flushText();
          break;
        case 'run_end':
          flushText();
          setFinished({
            stopReason: event.result.stopReason,
            durationMs: event.result.durationMs,
            steps: event.result.steps,
          });
          setUsage(event.result.usage);
          if (event.result.error) {
            setError({ code: event.result.error.code ?? 'E_INTERNAL', message: event.result.error.message });
          }
          break;
        case 'error':
          flushText();
          setError({ code: event.error.code ?? 'E_INTERNAL', message: event.error.message });
          break;
      }
    },
    [appendText, flushText, reducedMotion],
  );

  const run = useCallback(async () => {
    if (!input.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setItems([]);
    setUsage(null);
    setFinished(null);
    setError(null);
    setApproval(null);
    setApprovalError(null);
    setRunId(null);
    pendingText.current = '';
    setRunning(true);

    const body: RunRequestBody = { input, approvalMode };
    if (model) body.model = model;
    const steps = Number.parseInt(maxSteps, 10);
    if (Number.isFinite(steps) && steps > 0) body.maxSteps = steps;

    try {
      for await (const event of api.runStream(name, body, controller.signal)) {
        // The terminating `event: done` frame arrives as `{}`; it is not a RunEvent.
        if (!isRunEvent(event)) continue;
        handleEvent(event);
      }
    } catch (err) {
      if (!isAbort(err) && !controller.signal.aborted) setError(toDisplayError(err));
    } finally {
      setRunning(false);
      setApproval(null);
      abortRef.current = null;
    }
  }, [api, approvalMode, handleEvent, input, maxSteps, model, name]);

  const answer = useCallback(
    async (approve: boolean) => {
      if (!approval) return;
      setApprovalError(null);
      try {
        await api.answerApproval(approval.approvalId, approve);
        setApproval(null);
      } catch (err) {
        setApprovalError(toDisplayError(err));
      }
    },
    [api, approval],
  );

  const availableModels = models.data?.models ?? [];
  const secondsLeft = approval ? Math.max(0, Math.ceil((approval.askedAt + APPROVAL_TIMEOUT_MS - now) / 1000)) : 0;

  return (
    <div>
      <h2>Playground</h2>
      <p className="hint">
        <code>
          POST /v1/husks/{name}/run/stream
        </code>{' '}
        — the events below are the server's, unedited.
      </p>

      <form
        className="row-gap-4"
        style={{ marginTop: 'var(--space-4)' }}
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Field label="Input" htmlFor="pg-input">
          <textarea
            id="pg-input"
            className="textarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What should this husk do?"
          />
        </Field>

        <div className="form-grid">
          <Field
            label="Model override"
            htmlFor="pg-model"
            note={
              models.data && availableModels.length === 0
                ? 'No model provider is available — see Doctor.'
                : 'Blank uses the husk’s own model.'
            }
          >
            <select id="pg-model" className="select" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">husk default</option>
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.free ? ' · free' : ''}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Approvals" htmlFor="pg-approval" note="ask pauses on every dangerous tool call.">
            <select
              id="pg-approval"
              className="select"
              value={approvalMode}
              onChange={(e) => setApprovalMode(e.target.value as 'auto' | 'ask' | 'readonly')}
            >
              <option value="ask">ask</option>
              <option value="auto">auto</option>
              <option value="readonly">readonly</option>
            </select>
          </Field>

          <Field label="Max steps" htmlFor="pg-steps">
            <input
              id="pg-steps"
              className="input mono tnum"
              inputMode="numeric"
              value={maxSteps}
              onChange={(e) => setMaxSteps(e.target.value)}
            />
          </Field>
        </div>

        <div className="btn-row">
          <Button type="submit" variant="primary" disabled={running || !input.trim()}>
            Run
          </Button>
          <Button variant="secondary" onClick={() => abortRef.current?.abort()} disabled={!running}>
            Stop
          </Button>
          {runId ? <code className="mono field-note">{runId}</code> : null}
        </div>
      </form>

      {approval ? (
        <div className="approval" role="alertdialog" aria-labelledby="approval-title" style={{ marginTop: 'var(--space-4)' }}>
          <h3 id="approval-title">Approval required</h3>
          <p style={{ margin: 'var(--space-2) 0', fontSize: 'var(--font-size-sm)' }}>{approval.prompt}</p>
          {approval.tool ? (
            <dl className="kv">
              <dt>tool</dt>
              <dd>{approval.tool}</dd>
              {approval.args ? (
                <>
                  <dt>args</dt>
                  <dd>{JSON.stringify(approval.args)}</dd>
                </>
              ) : null}
              <dt>id</dt>
              <dd>{approval.approvalId}</dd>
            </dl>
          ) : null}
          <p className="field-note tnum" style={{ marginTop: 'var(--space-2)' }}>
            The server denies this automatically in {secondsLeft}s.
          </p>
          <div className="btn-row" style={{ marginTop: 'var(--space-3)' }}>
            <Button variant="primary" onClick={() => void answer(true)}>
              Approve
            </Button>
            <Button variant="danger" onClick={() => void answer(false)}>
              Deny
            </Button>
          </div>
          {approvalError ? <ErrorBlock error={approvalError} /> : null}
        </div>
      ) : null}

      {items.length > 0 ? (
        <div
          className="stream"
          ref={streamRef}
          style={{ marginTop: 'var(--space-4)' }}
          aria-busy={running || undefined}
          aria-live="polite"
        >
          {items.map((item) => (item.kind === 'tool' ? <ToolBlock key={item.id} item={item} /> : <TextBlock key={item.id} item={item} />))}
        </div>
      ) : null}

      {running && items.length === 0 ? (
        <StatusLine text="Waiting for the first event from the model…" />
      ) : null}

      {error ? (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <ErrorBlock error={error} />
        </div>
      ) : null}

      {finished || usage ? (
        <dl className="kv" style={{ marginTop: 'var(--space-4)' }}>
          {finished ? (
            <>
              <dt>stop reason</dt>
              <dd>{finished.stopReason}</dd>
              <dt>steps</dt>
              <dd className="tnum">{finished.steps}</dd>
              <dt>duration</dt>
              <dd className="tnum">{finished.durationMs} ms</dd>
            </>
          ) : null}
          {usage ? (
            <>
              <dt>tokens</dt>
              <dd className="tnum">
                {usage.inputTokens} in / {usage.outputTokens} out
              </dd>
              <dt>cost</dt>
              <dd className="tnum">{usage.costUsd === undefined ? 'unknown' : `$${usage.costUsd.toFixed(4)}`}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

function TextBlock({ item }: { item: TextItem }) {
  const label =
    item.kind === 'text' ? 'assistant' : item.kind === 'thinking' ? 'thinking' : item.kind === 'warning' ? 'warning' : 'run';
  return (
    <div className="stream-item">
      <span className="stream-label">{label}</span>
      <p className={`stream-text${item.kind === 'text' ? '' : ' stream-mono'}`}>{item.text}</p>
    </div>
  );
}

function ToolBlock({ item }: { item: ToolItem }) {
  return (
    <div className={`stream-item stream-tool${item.isError || item.denied ? ' stream-tool-error' : ''}`}>
      <span className="stream-label">
        tool · {item.name}
        {item.done ? ` · ${item.denied ? 'denied' : item.isError ? 'error' : 'ok'}` : ' · running'}
        {item.durationMs === undefined ? '' : ` · ${item.durationMs} ms`}
      </span>
      <p className="stream-text stream-mono">{JSON.stringify(item.args)}</p>
      {item.stream ? <p className="stream-text stream-mono">{item.stream}</p> : null}
      {item.denied ? <p className="stream-text stream-mono">denied: {item.denied}</p> : null}
      {item.output ? <p className="stream-text stream-mono">{item.output}</p> : null}
    </div>
  );
}

function isRunEvent(event: RunStreamEvent): event is RunEvent {
  return typeof (event as { type?: unknown }).type === 'string';
}
