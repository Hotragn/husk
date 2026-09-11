import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import matter from 'gray-matter';

/**
 * The content pipeline.
 *
 * Pages are MDX files on disk under `content/`. Their frontmatter is the only
 * source of navigation: there is no hand-maintained sidebar array to drift out
 * of sync with the filesystem, and adding a page means adding one file.
 *
 * Everything here runs at build time in a server component. Nothing in this
 * module may be imported from a client component.
 */

export const CONTENT_ROOT = join(process.cwd(), 'content');

/**
 * Pages that sit directly in `content/` rather than in a section directory.
 *
 * `/faq` and `/troubleshooting` are the two pages a stuck reader types by hand,
 * so they keep short top-level URLs instead of being filed under a section.
 */
export const ROOT_SECTION = '';

/** Section directories, in sidebar order. A directory not listed here is not shipped. */
const SECTIONS: Array<{ dir: string; title: string }> = [
  { dir: 'start', title: 'Start here' },
  { dir: 'computers', title: 'Computers' },
  { dir: 'chat-to-bot', title: 'Chat to bot' },
  { dir: 'mcp', title: 'MCP' },
  { dir: 'models', title: 'Models' },
  { dir: 'security', title: 'Security' },
  { dir: 'guides', title: 'Guides' },
  { dir: 'reference', title: 'Reference' },
  { dir: ROOT_SECTION, title: 'Help' },
];

export interface Frontmatter {
  title: string;
  /** One sentence. Used for the page description, search, and the section index. */
  description: string;
  /** Sidebar position within the section. Lower is higher. */
  order: number;
  /** Overrides the sidebar label when the page title is too long for the rail. */
  navTitle?: string;
}

export interface Doc {
  /** URL path segments, e.g. ['computers', 'providers']. */
  slug: string[];
  /** URL path, e.g. '/computers/providers'. */
  href: string;
  section: string;
  sectionTitle: string;
  frontmatter: Frontmatter;
  body: string;
  filePath: string;
}

export interface NavSection {
  dir: string;
  title: string;
  items: Array<{ href: string; title: string; description: string }>;
}

let cache: Doc[] | undefined;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.mdx')) out.push(full);
  }
  return out;
}

function slugFor(filePath: string): string[] {
  const rel = relative(CONTENT_ROOT, filePath).replace(/\.mdx$/, '');
  const parts = rel.split(sep);
  // `computers/index.mdx` is the section landing page at /computers.
  if (parts[parts.length - 1] === 'index') parts.pop();
  return parts;
}

/**
 * Which section a file belongs to, taken from its directory rather than its slug.
 *
 * The two differ for exactly the pages that matter here: `computers/index.mdx` has
 * the one-segment slug `['computers']` and lives in the `computers` section, while
 * `faq.mdx` also has a one-segment slug and lives at the root. Reading `slug[0]`
 * conflates them and silently drops every root-level page.
 */
function sectionDirFor(filePath: string): string {
  const parts = relative(CONTENT_ROOT, filePath).split(sep);
  return parts.length > 1 ? (parts[0] as string) : ROOT_SECTION;
}

function readDoc(filePath: string): Doc | undefined {
  const raw = readFileSync(filePath, 'utf8');
  const parsed = matter(raw);
  const data = parsed.data as Partial<Frontmatter>;

  if (!data.title || !data.description || typeof data.order !== 'number') {
    throw new Error(
      `${relative(CONTENT_ROOT, filePath)} is missing frontmatter. ` +
        'Every page needs title, description and order.',
    );
  }

  const slug = slugFor(filePath);
  const section = SECTIONS.find((s) => s.dir === sectionDirFor(filePath));
  if (!section) return undefined;

  return {
    slug,
    href: '/' + slug.join('/'),
    section: section.dir,
    sectionTitle: section.title,
    frontmatter: {
      title: data.title,
      description: data.description,
      order: data.order,
      ...(data.navTitle ? { navTitle: data.navTitle } : {}),
    },
    body: parsed.content,
    filePath,
  };
}

/** Every shipped page, in sidebar order. The order is also the prev/next order. */
export function allDocs(): Doc[] {
  if (cache) return cache;

  const docs = walk(CONTENT_ROOT)
    .map(readDoc)
    .filter((d): d is Doc => d !== undefined);

  const sectionIndex = new Map(SECTIONS.map((s, i) => [s.dir, i]));
  docs.sort((a, b) => {
    const sa = sectionIndex.get(a.section) ?? 99;
    const sb = sectionIndex.get(b.section) ?? 99;
    if (sa !== sb) return sa - sb;
    if (a.frontmatter.order !== b.frontmatter.order) return a.frontmatter.order - b.frontmatter.order;
    return a.href.localeCompare(b.href);
  });

  cache = docs;
  return docs;
}

export function docBySlug(slug: string[]): Doc | undefined {
  const href = '/' + slug.join('/');
  return allDocs().find((d) => d.href === href);
}

export function nav(): NavSection[] {
  const docs = allDocs();
  return SECTIONS.map((s) => ({
    dir: s.dir,
    title: s.title,
    items: docs
      .filter((d) => d.section === s.dir)
      .map((d) => ({
        href: d.href,
        title: d.frontmatter.navTitle ?? d.frontmatter.title,
        description: d.frontmatter.description,
      })),
  })).filter((s) => s.items.length > 0);
}

export interface Neighbours {
  previous?: { href: string; title: string };
  next?: { href: string; title: string };
}

export function neighbours(href: string): Neighbours {
  const docs = allDocs();
  const i = docs.findIndex((d) => d.href === href);
  if (i === -1) return {};
  const prev = i > 0 ? docs[i - 1] : undefined;
  const next = i < docs.length - 1 ? docs[i + 1] : undefined;
  return {
    ...(prev ? { previous: { href: prev.href, title: prev.frontmatter.title } } : {}),
    ...(next ? { next: { href: next.href, title: next.frontmatter.title } } : {}),
  };
}

export interface TocEntry {
  depth: 2 | 3;
  text: string;
  id: string;
}

/**
 * Headings for the on-page table of contents.
 *
 * Parsed from the MDX source rather than from the rendered tree, because the
 * TOC has to render in the page shell alongside the article, not inside it.
 * Fenced code blocks are skipped so a `# comment` in a shell snippet does not
 * become a heading, and the slug algorithm matches rehype-slug's.
 */
export function toc(body: string): TocEntry[] {
  const out: TocEntry[] = [];
  let inFence = false;
  let fence = '';

  for (const line of body.split('\n')) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] as string;
      if (!inFence) {
        inFence = true;
        fence = marker[0] as string;
      } else if (marker[0] === fence) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const heading = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (!heading) continue;
    const depth = (heading[1] as string).length === 2 ? 2 : 3;
    const text = stripInline(heading[2] as string);
    out.push({ depth, text, id: githubSlug(text) });
  }

  return out;
}

/** Strip the markdown a heading is allowed to contain: code spans, links, emphasis. */
function stripInline(input: string): string {
  return input
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_)/g, '')
    .trim();
}

/** github-slugger's algorithm, which is what rehype-slug uses. */
export function githubSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
    .replace(/\s+/g, '-');
}
