import { open, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** A stat plus the first and last N bytes. Never reads the middle of a big file. */
export interface HeadTail {
  path: string;
  size: number;
  mtime: Date;
  head: string;
  tail: string;
  /** true when head + tail together cover the whole file, so counts are exact. */
  complete: boolean;
}

export const DEFAULT_WINDOW = 96 * 1024;

export async function readHeadTail(path: string, windowBytes = DEFAULT_WINDOW): Promise<HeadTail> {
  const st = await stat(path);
  const size = st.size;
  const fh = await open(path, 'r');
  try {
    if (size <= windowBytes * 2) {
      const buf = Buffer.allocUnsafe(size);
      await fh.read(buf, 0, size, 0);
      const text = buf.toString('utf8');
      return { path, size, mtime: st.mtime, head: text, tail: '', complete: true };
    }
    const headBuf = Buffer.allocUnsafe(windowBytes);
    const tailBuf = Buffer.allocUnsafe(windowBytes);
    await fh.read(headBuf, 0, windowBytes, 0);
    await fh.read(tailBuf, 0, windowBytes, size - windowBytes);
    return {
      path,
      size,
      mtime: st.mtime,
      head: headBuf.toString('utf8'),
      tail: tailBuf.toString('utf8'),
      complete: false,
    };
  } finally {
    await fh.close();
  }
}

/**
 * Whole lines only. A window read almost always starts and ends mid-line, and a
 * half-line of JSON is worse than no line at all.
 */
export function wholeLines(chunk: string, dropFirst: boolean, dropLast: boolean): string[] {
  const lines = chunk.split('\n');
  if (dropFirst && lines.length) lines.shift();
  if (dropLast && lines.length) lines.pop();
  return lines.filter((l) => l.trim() !== '');
}

export async function listFiles(dir: string, ext: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(ext)).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
