/**
 * The filesystem of a computer: `GET /v1/computers/:id/fs`, `fs/read`,
 * `fs/write`, `DELETE fs`.
 *
 * Real bytes in both directions. `fs/read` returns the file itself, not a JSON
 * envelope, so the editor decodes it here and refuses to pretend a binary is
 * text. The path jail's `E_FS_DENIED` is rendered exactly as the server phrased
 * it — its message already names the two writable roots, which is more useful
 * than anything this panel could invent.
 *
 * There is no `POST /fs/upload` on this server -- see "Not implemented yet" in
 * `docs/API.md` -- so "upload" reads the chosen file in the browser and PUTs
 * its bytes to `fs/write`. That is the same operation with one fewer endpoint,
 * and it is real either way.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection } from '../state/connection';
import { useComputers } from '../state/computers';
import { computerGate } from './computerGate';
import { useResource } from '../state/useResource';
import { toDisplayError } from '../api/client';
import type { DisplayError } from '../api/client';
import type { DirEntry } from '../api/wire';
import {
  Badge,
  Button,
  EmptyState,
  ErrorBlock,
  PanelHeader,
  Skeleton,
  StatusLine,
  bytesToText,
  formatBytes,
  formatWhen,
} from '../components/primitives';

const MAX_EDITABLE_BYTES = 512 * 1024;

function parentOf(path: string): string {
  if (path === '/' || path === '') return '/';
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

function join(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

interface OpenFile {
  path: string;
  text: string;
  original: string;
  binary: boolean;
  size: number;
}

export function FilesPanel({
  activeId,
  onSelect,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const { api, revision } = useConnection();
  const computers = useComputers();
  const active = computers.list.find((c) => c.id === activeId) ?? null;

  const [path, setPath] = useState('/work');
  const [pathDraft, setPathDraft] = useState('/work');
  const [open, setOpen] = useState<OpenFile | null>(null);
  const [fileError, setFileError] = useState<DisplayError | null>(null);
  const [busy, setBusy] = useState<'reading' | 'saving' | 'deleting' | 'uploading' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const next = active?.workdir ?? '/work';
    setPath(next);
    setPathDraft(next);
    setOpen(null);
    setFileError(null);
    setNotice(null);
  }, [active?.id, active?.workdir]);

  // Polled, because the agent writes to this directory and nothing tells us when.
  // `exec` cannot report which files a command touched, so without this the panel
  // keeps saying "/work is empty" while the agent fills it.
  const dir = useResource<DirEntry[]>(
    (signal) => api.listDir(activeId ?? '', path, signal),
    [api, activeId, path, revision],
    Boolean(activeId),
    { refreshMs: 4000 },
  );

  const openFile = useCallback(
    async (entry: DirEntry) => {
      if (!activeId) return;
      setBusy('reading');
      setFileError(null);
      setNotice(null);
      try {
        const bytes = await api.readFileBytes(activeId, entry.path);
        const { text, binary } = bytesToText(bytes);
        setOpen({ path: entry.path, text, original: text, binary, size: bytes.byteLength });
      } catch (err) {
        setOpen(null);
        setFileError(toDisplayError(err));
      } finally {
        setBusy(null);
      }
    },
    [api, activeId],
  );

  const save = useCallback(async () => {
    if (!activeId || !open || open.binary) return;
    setBusy('saving');
    setFileError(null);
    try {
      await api.writeFileBytes(activeId, open.path, new TextEncoder().encode(open.text));
      setOpen({ ...open, original: open.text, size: new TextEncoder().encode(open.text).byteLength });
      setNotice(`Wrote ${open.path}.`);
      dir.reload();
    } catch (err) {
      setFileError(toDisplayError(err));
    } finally {
      setBusy(null);
    }
  }, [api, activeId, dir, open]);

  const remove = useCallback(
    async (entry: DirEntry) => {
      if (!activeId) return;
      const recursive = entry.type === 'dir';
      const ok = window.confirm(
        recursive ? `Delete the directory ${entry.path} and everything under it?` : `Delete ${entry.path}?`,
      );
      if (!ok) return;
      setBusy('deleting');
      setFileError(null);
      try {
        await api.removeFile(activeId, entry.path, recursive);
        if (open?.path === entry.path) setOpen(null);
        setNotice(`Deleted ${entry.path}.`);
        dir.reload();
      } catch (err) {
        setFileError(toDisplayError(err));
      } finally {
        setBusy(null);
      }
    },
    [api, activeId, dir, open?.path],
  );

  const upload = useCallback(
    async (file: File) => {
      if (!activeId) return;
      setBusy('uploading');
      setFileError(null);
      setNotice(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const target = join(path, file.name);
        await api.writeFileBytes(activeId, target, bytes);
        setNotice(`Uploaded ${file.name} — ${formatBytes(bytes.byteLength)} to ${target}.`);
        dir.reload();
      } catch (err) {
        setFileError(toDisplayError(err));
      } finally {
        setBusy(null);
        if (uploadRef.current) uploadRef.current.value = '';
      }
    },
    [api, activeId, dir, path],
  );

  const gate = computerGate({
    computers,
    title: 'Files',
    lede: 'GET /v1/computers/:id/fs',
    emptyTitle: 'No computer to browse.',
    emptyBody:
      "A filesystem belongs to a machine, and there is no machine yet. Create one on the Computers panel.",
  });
  if (gate) return <>{gate}</>;

  const entries = dir.data ?? [];
  const dirty = open !== null && open.text !== open.original;

  return (
    <section className="panel" aria-labelledby="files-title">
      <PanelHeader
        title="Files"
        lede="Real bytes off the machine. The path jail's refusals are shown exactly as the server words them."
        actions={
          <>
            <label className="visually-hidden" htmlFor="files-computer">
              Computer
            </label>
            <select
              id="files-computer"
              className="select"
              style={{ width: 'auto' }}
              value={activeId ?? ''}
              onChange={(e) => onSelect(e.target.value)}
            >
              {computers.list.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id} · {c.provider} · {c.state}
                </option>
              ))}
            </select>
            <Button onClick={dir.reload}>Refresh</Button>
          </>
        }
      />
      <span id="files-title" className="visually-hidden">
        Files
      </span>

      <form
        className="inline-gap"
        style={{ marginBottom: 'var(--space-4)' }}
        onSubmit={(e) => {
          e.preventDefault();
          setPath(pathDraft.trim() || '/');
        }}
      >
        <label htmlFor="files-path" className="field-label">
          Path
        </label>
        <input
          id="files-path"
          className="input mono"
          style={{ maxWidth: '32rem' }}
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          spellCheck={false}
        />
        <Button type="submit">Go</Button>
        <Button
          variant="ghost"
          onClick={() => {
            const up = parentOf(path);
            setPath(up);
            setPathDraft(up);
          }}
          disabled={path === '/'}
        >
          Up
        </Button>
        <Button
          variant="ghost"
          onClick={() => uploadRef.current?.click()}
          loading={busy === 'uploading'}
        >
          Upload a file here
        </Button>
        <input
          ref={uploadRef}
          type="file"
          className="visually-hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </form>

      {notice ? (
        <p className="hint" role="status">
          {notice}
        </p>
      ) : null}
      {fileError ? <ErrorBlock error={fileError} /> : null}
      {dir.error ? <ErrorBlock error={dir.error} retry={dir.reload} /> : null}

      <div className="split">
        <div>
          {!dir.data && dir.loading && dir.slow ? <StatusLine text={`Listing ${path}…`} /> : null}
          {!dir.data && dir.showSkeleton && !dir.slow ? <Skeleton rows={6} /> : null}

          {dir.data && entries.length === 0 ? (
            <EmptyState
              title={`${path} is empty.`}
              body="Nothing has been written here yet. Upload a file, or have a command create one."
              command={`husk exec ${activeId ?? '<id>'} -- touch ${join(path, 'notes.txt')}`}
            />
          ) : null}

          {entries.length > 0 ? (
            <div className="table-scroll">
              <table className="data">
                <caption>
                  {entries.length} entr{entries.length === 1 ? 'y' : 'ies'} in <code>{path}</code>
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col">Size</th>
                    <th scope="col">Modified</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.path} aria-selected={open?.path === entry.path}>
                      <td className="mono">
                        {entry.type === 'dir' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setPath(entry.path);
                              setPathDraft(entry.path);
                            }}
                          >
                            {entry.name}/
                          </Button>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => void openFile(entry)}>
                            {entry.name}
                          </Button>
                        )}
                      </td>
                      <td>{entry.type}</td>
                      <td className="mono tnum">{entry.type === 'dir' ? '—' : formatBytes(entry.size)}</td>
                      <td className="mono tnum">{formatWhen(entry.modifiedAt)}</td>
                      <td className="actions">
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => void remove(entry)}
                          loading={busy === 'deleting'}
                          aria-label={`Delete ${entry.path}`}
                        >
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        <div>
          <h2>Editor</h2>
          {busy === 'reading' ? <StatusLine text="Reading the file…" /> : null}

          {!open && busy !== 'reading' ? (
            <p className="hint">Choose a file on the left to read its bytes.</p>
          ) : null}

          {open ? (
            <div className="row-gap-2" style={{ marginTop: 'var(--space-3)' }}>
              <div className="inline-gap">
                <code className="mono">{open.path}</code>
                <Badge>{formatBytes(open.size)}</Badge>
                {open.binary ? <Badge tone="warn">binary</Badge> : null}
                {dirty ? <Badge tone="info">unsaved</Badge> : null}
              </div>

              {open.binary ? (
                <div className="state">
                  <h3>This file is not text.</h3>
                  <p>
                    It contains a NUL byte, so decoding it as UTF-8 would corrupt it. The console will not offer an
                    editor it cannot round-trip.
                  </p>
                </div>
              ) : open.size > MAX_EDITABLE_BYTES ? (
                <div className="state">
                  <h3>Too large to edit here — {formatBytes(open.size)}.</h3>
                  <p>The editor caps at {formatBytes(MAX_EDITABLE_BYTES)} so a save cannot silently truncate.</p>
                </div>
              ) : (
                <>
                  <label className="visually-hidden" htmlFor="file-editor">
                    Contents of {open.path}
                  </label>
                  <textarea
                    id="file-editor"
                    className="textarea mono"
                    style={{ minHeight: '22rem' }}
                    spellCheck={false}
                    value={open.text}
                    onChange={(e) => setOpen({ ...open, text: e.target.value })}
                  />
                  <div className="btn-row">
                    <Button variant="primary" onClick={() => void save()} loading={busy === 'saving'} disabled={!dirty}>
                      Save to the machine
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setOpen({ ...open, text: open.original })}
                      disabled={!dirty}
                    >
                      Revert
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
