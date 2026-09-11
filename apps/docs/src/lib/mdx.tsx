import type { ComponentPropsWithoutRef } from 'react';
import Link from 'next/link';
import { MDXRemote } from 'next-mdx-remote/rsc';
import type { Element, Root, RootContent } from 'hast';
import { visit } from 'unist-util-visit';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypePrettyCode from 'rehype-pretty-code';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import { CodeFigure } from '@/components/CodeBlock';
import { Danger, Note, NotYet, Warning } from '@/components/Callout';
import { Terminal } from '@/components/Terminal';
import { huskDark, huskLight } from './shiki-theme';

/**
 * Attach the plain source of each code block to its figure as `data-raw`.
 *
 * Runs after rehype-pretty-code, so the tree is already tokenised. Lines are
 * reassembled from the `data-line` spans rather than from the raw text nodes,
 * because that is exactly what the reader sees and therefore exactly what the
 * copy button should hand them.
 */
function rehypeRawCode() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'figure') return;
      if (!Object.hasOwn(node.properties ?? {}, 'data-rehype-pretty-code-figure')) return;

      const pre = node.children.find(
        (c): c is Element => c.type === 'element' && c.tagName === 'pre',
      );
      if (!pre) return;
      const code = pre.children.find(
        (c): c is Element => c.type === 'element' && c.tagName === 'code',
      );
      if (!code) return;

      const lines = code.children
        .filter((c): c is Element => c.type === 'element')
        .map((line) => textOf(line));

      node.properties = { ...node.properties, 'data-raw': lines.join('\n') };
    });
  };
}

function textOf(node: RootContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(textOf).join('');
  return '';
}

const rehypePlugins = [
  rehypeSlug,
  [
    rehypeAutolinkHeadings,
    {
      behavior: 'append',
      properties: { className: 'heading-anchor', 'aria-label': 'Link to this section' },
    },
  ],
  [
    rehypePrettyCode,
    {
      // Both palettes are baked in and CSS picks one, so the theme toggle does
      // not need a re-highlight or a second network request.
      theme: { dark: huskDark, light: huskLight },
      // The frame's background comes from --color-sunken, so Shiki's own is
      // one more colour that would not be in the token set.
      keepBackground: false,
      // Inline code in this documentation is a symbol name, not a program.
      // Highlighting it makes a paragraph look like a ransom note.
      bypassInlineCode: true,
      defaultLang: { block: 'text' },
    },
  ],
  rehypeRawCode,
] as const;

/**
 * Element overrides.
 *
 * Only three tags are replaced, and each for a structural reason: figures need
 * a copy button, tables need a scroll container at 320px, and internal links
 * need the client-side router.
 */
const components = {
  figure: (props: ComponentPropsWithoutRef<'figure'> & { 'data-raw'?: string }) =>
    Object.hasOwn(props, 'data-rehype-pretty-code-figure') ? (
      <CodeFigure {...props} />
    ) : (
      <figure {...props} />
    ),

  figcaption: (props: ComponentPropsWithoutRef<'figcaption'>) =>
    Object.hasOwn(props, 'data-rehype-pretty-code-title') ? (
      <figcaption {...props} className="code-title" />
    ) : (
      <figcaption {...props} />
    ),

  // A table is genuinely two-dimensional content, so it is allowed to scroll
  // inside its own region at a 320px viewport. UI-PRINCIPLES section 7.
  table: (props: ComponentPropsWithoutRef<'table'>) => (
    <div className="table-scroll">
      <table {...props} />
    </div>
  ),

  a: ({ href = '', ...rest }: ComponentPropsWithoutRef<'a'>) =>
    href.startsWith('/') ? (
      <Link href={href} {...rest} />
    ) : (
      <a href={href} {...rest} rel="noreferrer noopener" target="_blank" />
    ),

  Note,
  Warning,
  Danger,
  NotYet,
  Terminal,
};

export function Mdx({ source }: { source: string }) {
  return (
    <MDXRemote
      source={source}
      components={components}
      options={{
        parseFrontmatter: true,
        mdxOptions: {
          remarkPlugins: [remarkGfm],
          // The plugin tuple types from unified do not narrow through a
          // readonly array literal; the shapes are checked by the plugins
          // themselves at build time, and a bad option fails the build loudly.
          rehypePlugins: rehypePlugins as never,
        },
      }}
    />
  );
}
