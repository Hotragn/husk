/**
 * Just enough HTML to text for a model to read a page.
 *
 * A real DOM parser would be a dependency, and the build contract says to add
 * one only when writing it ourselves would be irresponsible. Reading prose off a
 * page is not that: we drop the parts that are never prose, turn block elements
 * into newlines, and collapse the rest.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  times: '×',
  copy: '©',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m || !m[1]) return undefined;
  return decodeEntities(m[1]).replace(/\s+/g, ' ').trim() || undefined;
}

const DROP_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'nav', 'footer'];
const BLOCK = /<\/?(p|div|section|article|header|main|aside|ul|ol|dl|dd|dt|table|thead|tbody|tfoot|form|figure|blockquote|pre|h[1-6])\b[^>]*>/gi;

export function htmlToText(html: string): string {
  let out = html;
  for (const tag of DROP_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), ' ');
  }
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/(li|tr)>/gi, '\n');
  out = out.replace(/<li\b[^>]*>/gi, '\n- ');
  out = out.replace(/<\/(td|th)>/gi, '\t');
  out = out.replace(BLOCK, '\n\n');
  out = out.replace(/<[^>]+>/g, '');
  out = decodeEntities(out);
  out = out.replace(/\r\n?/g, '\n');
  out = out
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

export function looksLikeHtml(contentType: string | null, body: string): boolean {
  if (contentType && /text\/html|application\/xhtml/i.test(contentType)) return true;
  if (contentType) return false;
  return /<\s*(html|head|body|div|p)\b/i.test(body.slice(0, 2000));
}
