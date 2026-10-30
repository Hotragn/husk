/**
 * JSON as chat apps keep their settings, with comments and trailing commas
 * where the app allows them (Zed does), edited in place: one member changes
 * and every other byte of the file stays as the person left it.
 */

interface Token {
  kind: '{' | '}' | '[' | ']' | ':' | ',' | 'string' | 'value';
  start: number;
  end: number;
}

/** The text's tokens, without whitespace and comments. Throws where the text cannot be JSON. */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (/\s/.test(c)) {
      i++;
    } else if (text.startsWith('//', i)) {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl;
    } else if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) throw new Error('a comment is not closed');
      i = close + 2;
    } else if ('{}[]:,'.includes(c)) {
      out.push({ kind: c as Token['kind'], start: i, end: ++i });
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) throw new Error('a string is not closed');
      out.push({ kind: 'string', start: i, end: (i = j + 1) });
    } else {
      let j = i;
      while (j < text.length && !/[\s{}[\]:,"/]/.test(text[j] as string)) j++;
      if (j === i) throw new Error(`unexpected ${c}`);
      out.push({ kind: 'value', start: i, end: (i = j) });
    }
  }
  return out;
}

const trailingComma = (t: Token[], i: number) => t[i]?.kind === ',' && (t[i + 1]?.kind === '}' || t[i + 1]?.kind === ']');

/** Parse JSON that may carry comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  const t = tokenize(text);
  return JSON.parse(t.flatMap((x, i) => (trailingComma(t, i) ? [] : [text.slice(x.start, x.end)])).join(' '));
}

interface Member {
  key: string;
  /** The key's token. */
  first: number;
  value: Node;
}

interface Node {
  start: number;
  end: number;
  /** The node's last token. */
  last: number;
  /** An object's members, in order. */
  members?: Member[];
}

/** The value starting at token `i` of text that already parsed. */
function nodeAt(text: string, t: Token[], i: number): Node {
  const open = t[i] as Token;
  if (open.kind !== '{' && open.kind !== '[') return { start: open.start, end: open.end, last: i };
  const members: Member[] = [];
  let j = i + 1;
  while ((t[j] as Token).kind !== (open.kind === '{' ? '}' : ']')) {
    const first = j;
    const key = open.kind === '{' ? (JSON.parse(text.slice(t[j]!.start, t[j]!.end)) as string) : undefined;
    if (key !== undefined) j += 2;
    const value = nodeAt(text, t, j);
    j = value.last + 1;
    if (t[j]?.kind === ',') j++;
    if (key !== undefined) members.push({ key, first, value });
  }
  return { start: open.start, end: (t[j] as Token).end, last: j, ...(open.kind === '{' ? { members } : {}) };
}

/**
 * `text` with `[key][name]` set to `value`, or removed when `value` is
 * undefined, and nothing else changed. A missing `key` object is added. The
 * last of two same-named members is the one changed, as JSON.parse reads it.
 */
export function setMember(text: string, key: string, name: string, value: unknown): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  if (text.trim() === '') return value === undefined ? text : `${JSON.stringify({ [key]: { [name]: value } }, null, 2).replace(/\n/g, nl)}${nl}`;
  parseJsonc(text);
  const t = tokenize(text);
  const root = nodeAt(text, t, 0);
  if (!root.members) throw new Error('the file is not an object');
  // The file's own indent: what stands before its first member's key, two spaces if nothing does.
  const firstKey = root.members[0] ? t[root.members[0].first]!.start : -1;
  const lineStart = text.lastIndexOf('\n', firstKey) + 1;
  const unit = firstKey > 0 && /^[ \t]+$/.test(text.slice(lineStart, firstKey)) ? text.slice(lineStart, firstKey) : '  ';
  const format = (v: unknown, depth: number) => JSON.stringify(v, null, unit).replace(/\n/g, nl + unit.repeat(depth));

  const insert = (obj: Node, member: string, depth: number) => {
    const at = obj.start + 1;
    const line = `${nl}${unit.repeat(depth)}${member}`;
    if (obj.members!.length) return `${text.slice(0, at)}${line},${text.slice(at)}`;
    const inside = text.slice(at, obj.end - 1);
    return inside.trim() === ''
      ? `${text.slice(0, at)}${line}${nl}${unit.repeat(depth - 1)}${text.slice(obj.end - 1)}`
      : `${text.slice(0, at)}${line}${text.slice(at)}`;
  };

  const outer = root.members.findLast((m) => m.key === key);
  if (!outer) return value === undefined ? text : insert(root, `${JSON.stringify(key)}: ${format({ [name]: value }, 1)}`, 1);
  const servers = outer.value.members;
  if (!servers) throw new Error(`"${key}" is not an object`);
  const inner = servers.findLast((m) => m.key === name);
  if (value !== undefined) {
    if (!inner) return insert(outer.value, `${JSON.stringify(name)}: ${format(value, 2)}`, 2);
    return `${text.slice(0, inner.value.start)}${format(value, 2)}${text.slice(inner.value.end)}`;
  }
  if (!inner) return text;
  // With the comma after it, or else the one before it, so the rest stays valid JSON.
  const before = t[inner.first - 1] as Token;
  const after = t[inner.value.last + 1] as Token;
  if (after.kind === ',') return `${text.slice(0, before.end)}${text.slice(after.end)}`;
  return `${text.slice(0, before.kind === ',' ? before.start : before.end)}${text.slice(inner.value.end)}`;
}
