import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { Pager } from '@/components/Pager';
import { SidebarNav } from '@/components/SidebarNav';
import { Toc } from '@/components/Toc';
import { allDocs, docBySlug, nav, neighbours, toc } from '@/lib/content';
import { Mdx } from '@/lib/mdx';

/**
 * Every documentation page.
 *
 * `generateStaticParams` enumerates the content directory, so the whole site
 * is prerendered at build time. `dynamicParams: false` means a URL that is not
 * a real page 404s during the build instead of at request time -- a broken
 * link should fail CI, not a reader.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return allDocs().map((doc) => ({ slug: doc.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = docBySlug(slug);
  if (!doc) return {};
  return {
    title: doc.frontmatter.title,
    description: doc.frontmatter.description,
  };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const doc = docBySlug(slug);
  if (!doc) notFound();

  const headings = toc(doc.body);
  const around = neighbours(doc.href);

  return (
    <div className="layout">
      <aside className="rail rail-nav">
        <SidebarNav nav={nav()} />
      </aside>

      <main className="content" id="content">
        <p className="eyebrow">{doc.sectionTitle}</p>
        <h1 className="page-title">{doc.frontmatter.title}</h1>
        <p className="page-lead">{doc.frontmatter.description}</p>

        <article className="prose page-body">
          <Mdx source={doc.body} />
        </article>

        <Pager {...around} />
      </main>

      <aside className="rail rail-toc">
        <Toc entries={headings} />
      </aside>
    </div>
  );
}
