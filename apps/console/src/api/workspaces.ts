import { errorFromResponse, transportError } from '@husk-ai/sdk';

export interface WorkspaceSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sourceCount: number;
  fileCount: number;
}

export interface WorkspaceSource {
  id: string;
  url: string;
  finalUrl: string;
  title: string;
  fetchedAt: string;
  excerpt: string;
  sha256: string;
  path: string;
  truncated: boolean;
  contentType: string;
}

export interface WorkspaceFile {
  path: string;
  sizeBytes: number;
  updatedAt: string;
  sourceIds: string[];
}

export interface WorkspaceManifest {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sources: WorkspaceSource[];
  files: WorkspaceFile[];
}

export interface WorkspaceCapabilities {
  available: boolean;
  provider?: string;
  isolationKind?: 'kernel' | 'machine' | 'guardrails' | 'none';
  reason?: string;
  hint?: string;
}

export interface WorkspaceContents {
  path: string;
  content: string;
  sourceIds: string[];
}

/** Every request, including downloads, carries the viewer token in a header. */
export class WorkspaceApi {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private async response(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`;
    const headers = new Headers(init.headers);
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    let response: Response;
    try {
      response = await fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(45_000) });
    } catch (error) {
      throw transportError(error, url);
    }
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      throw errorFromResponse(response.status, body, url);
    }
    return response;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await this.response(path, init)).json() as Promise<T>;
  }

  list(signal?: AbortSignal): Promise<{ workspaces: WorkspaceSummary[] }> {
    return this.json('/v1/workspaces', signal ? { signal } : {});
  }

  create(name: string): Promise<WorkspaceManifest> {
    return this.json('/v1/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  }

  get(id: string, signal?: AbortSignal): Promise<WorkspaceManifest> {
    return this.json(`/v1/workspaces/${encodeURIComponent(id)}`, signal ? { signal } : {});
  }

  addSource(id: string, url: string): Promise<{ source: WorkspaceSource; content: string }> {
    return this.json(`/v1/workspaces/${encodeURIComponent(id)}/sources`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
  }

  read(id: string, path: string, signal?: AbortSignal): Promise<WorkspaceContents> {
    return this.json(`/v1/workspaces/${encodeURIComponent(id)}/files?${new URLSearchParams({ path })}`, signal ? { signal } : {});
  }

  async download(id: string, path?: string): Promise<Blob> {
    const route = path === undefined ? 'export' : `download?${new URLSearchParams({ path })}`;
    return (await this.response(`/v1/workspaces/${encodeURIComponent(id)}/${route}`)).blob();
  }

  remove(id: string, confirmName: string): Promise<{ ok: true }> {
    return this.json(`/v1/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmName }) });
  }

  async capabilities(signal?: AbortSignal): Promise<WorkspaceCapabilities> {
    interface Provider {
      name: string;
      available: boolean;
      isolationKind?: WorkspaceCapabilities['isolationKind'];
      reason?: string;
      hint?: string;
    }
    const report = await this.json<{ providers: Provider[]; selected: Provider | null }>('/v1/capabilities', signal ? { signal } : {});
    const selected = report.selected;
    if (!selected) return { available: false, reason: 'No computer provider is ready.', hint: report.providers.map((provider) => `${provider.name}: ${provider.reason ?? 'unavailable'}${provider.hint ? `. ${provider.hint}` : ''}`).join(' ') };
    return {
      available: selected.available,
      provider: selected.name,
      ...(selected.isolationKind ? { isolationKind: selected.isolationKind } : {}),
      ...(selected.reason ? { reason: selected.reason } : {}),
      ...(selected.hint ? { hint: selected.hint } : {}),
    };
  }

  enableComputer(): Promise<{ profile: string }> {
    return this.json('/v1/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'computer', confirm: true }) });
  }
}

export function saveDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Keep the URL alive until the browser has consumed the click.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
