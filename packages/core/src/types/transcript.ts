/** Normalised conversation history, whatever it was exported from. */

export type TranscriptSource =
  | 'claude-code'
  | 'claude-web'
  | 'chatgpt'
  | 'cursor'
  | 'openai-api'
  | 'anthropic-api'
  | 'markdown'
  | 'jsonl'
  | 'gemini'
  | 'universal'
  | 'unknown';

export interface TranscriptMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  ts?: string;
  /** Present when the message is a tool call or a tool result. */
  toolName?: string;
  toolInput?: unknown;
  meta?: Record<string, unknown>;
}

export interface Transcript {
  id: string;
  source: TranscriptSource;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Where it came from: a file path, an export id, a URL. */
  origin?: string;
  messages: TranscriptMessage[];
  meta?: Record<string, unknown>;
}

export interface ImportInput {
  /** A file or directory path. */
  path?: string;
  /** Raw content, when the caller already has it. */
  content?: string;
  /** Hint the importer, skipping detection. */
  source?: TranscriptSource;
}

export interface TranscriptImporter {
  readonly id: TranscriptSource;
  readonly displayName: string;
  /** Cheap sniff returning a 0..1 confidence. Must not throw. */
  detect(input: { path?: string; content?: string }): Promise<number>;
  parse(input: ImportInput): Promise<Transcript[]>;
  /** Where this tool usually keeps its history, for zero-argument discovery. */
  defaultLocations?(): string[];
}

/** What the distiller pulls out of a transcript before it becomes a husk. */
export interface DistilledAgent {
  name: string;
  description: string;
  persona: string;
  knowledge: Array<{ title: string; content: string; source?: string }>;
  examples: Array<{ user: string; assistant: string }>;
  suggestedTools: string[];
  suggestedModel?: string;
  needsComputer: boolean;
  /** 0..1, how much signal the distiller actually found. */
  confidence: number;
  notes: string[];
}
