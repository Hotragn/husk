export interface SourceRecord {
  id: string;
  url: string;
  finalUrl: string;
  title: string;
  fetchedAt: string;
  excerpt: string;
  /** SHA-256 of the saved, extracted UTF-8 text (not the original web page). */
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
  sources: SourceRecord[];
  files: WorkspaceFile[];
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sourceCount: number;
  fileCount: number;
}

/** The fetch seam permits deterministic tests without allowing tools to override network policy. */
export interface FetchedSource {
  finalUrl: string;
  title: string;
  content: string;
  truncated: boolean;
  contentType: string;
}

export interface WorkspaceStoreOptions {
  root?: string;
  fetchSource?: (url: string) => Promise<FetchedSource>;
}
