import Link from 'next/link';
import type { Metadata } from 'next';
import { LinkPreview } from '@/components/LinkPreview';
import { Terminal } from '@/components/Terminal';
import { allDocs, nav } from '@/lib/content';
import { SITE_DESCRIPTION, SITE_NAME } from '@/lib/site';

const TITLE = 'Husk documentation';

export const metadata: Metadata = {
  title: TITLE,
  description: SITE_DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    url: '/',
    title: TITLE,
    description: SITE_DESCRIPTION,
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: SITE_DESCRIPTION },
};

/**
 * The landing page.
 *
 * No sidebar: this page is a directory, not a chapter. The hero carries a real
 * object rather than a gradient -- a terminal frame with unedited `husk up`
 * output, per UI-PRINCIPLES section 8.1. Nothing on it animates.
 */
export default function Home() {
  const sections = nav();

  /**
   * The five cross-references below point at pages that already carry a title
   * and a one-sentence description in their frontmatter. This reads those
   * rather than restating them, so a preview cannot drift from the page it is
   * previewing. The hash is dropped for the lookup and kept for the link.
   */
  const docs = allDocs();
  const preview = (href: string) => {
    /* noUncheckedIndexedAccess makes [0] possibly undefined even for split. */
    const path = href.split('#')[0] ?? href;
    const doc = docs.find((d) => d.href === path);
    return {
      href,
      image: `/preview${path}.png`,
      title: doc?.frontmatter.title ?? path,
      summary: doc?.frontmatter.description ?? '',
    };
  };

  return (
    <main className="landing" id="content">
      <section className="hero">
        <div>
          <p className="eyebrow">Husk 0.1.0 · Apache-2.0</p>
          <h1 className="hero-title">Give your agent a computer.</h1>
          <p className="hero-lead">
            A disposable Linux machine an agent can drive, and a way to turn a chat
            transcript into a bot. Runs on hardware you already own. No account, no
            telemetry.
          </p>

          <div className="hero-actions">
            <Link className="button button-primary" href="/start/quickstart">
              Quickstart
            </Link>
            <Link className="button button-secondary" href="/start">
              What Husk is
            </Link>
          </div>

          <p className="hero-note">
            On Docker and Podman you get kernel isolation. On the <code>local</code>{' '}
            provider you get process guardrails — a pinned working directory, a scrubbed
            environment, a command deny list. That stops accidents. It does not stop an
            adversary, and a prompt-injected model is closer to an adversary than to an
            accident. <Link href="/security">The security page</Link> is specific about
            which one you have.
          </p>
        </div>

        <Terminal title="husk up scratch">
          {`$ husk up scratch
creating scratch...
✓ scratch is up

  id         cmp_5j8svxeqer9p
  provider   local  (WSL2 (Ubuntu))
  isolation  guardrails only — not a sandbox
  workdir    /work
  network    egress

$ husk exec scratch -- 'uname -sr; echo hi > /work/a.txt; cat /work/a.txt'
Linux 6.18.33.2-microsoft-standard-WSL2
hi

$ husk exec scratch -- 'sudo rm -rf /'
error refused: privilege escalation
hint:  add a pattern to guardrails.allowCommands in husk.yaml if this is intentional`}
        </Terminal>
      </section>

      <section className="section">
        <h2 className="section-title">The whole install, for an MCP client</h2>
        <div className="landing-prose">
          <p>
            One line gives Claude Code — or Cursor, or Zed, or anything speaking MCP — a
            Linux machine mid-conversation.
          </p>
        </div>
        <Terminal>{`claude mcp add husk -- npx -y @husk-ai/mcp`}</Terminal>
        <div className="landing-prose">
          <p>
            There is no second step. Nothing is created until the model calls a tool, and
            the first tool result tells it plainly what kind of machine it got.{' '}
            <Link href="/mcp">MCP</Link> covers the tool list, the flags, and the other
            clients.
          </p>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">Documentation</h2>
        <div className="section-grid">
          {sections.map((section) => {
            const href = section.items[0]?.href ?? '/';
            return (
              <LinkPreview
                key={section.dir}
                href={href}
                /* The destination's own share card, from the same frontmatter
                   this card shows, so the preview cannot disagree with it. */
                image={`/preview${href}.png`}
                title={section.items[0]?.title ?? section.title}
                summary={section.items[0]?.description ?? ''}
                className="section-card"
              >
                <span className="section-card-title">
                  {section.title}
                  <span className="section-card-count">
                    {section.items.length} {section.items.length === 1 ? 'page' : 'pages'}
                  </span>
                </span>
                <span className="section-card-body">{section.items[0]?.description}</span>
              </LinkPreview>
            );
          })}
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">These docs describe the code, not the plan</h2>
        <div className="landing-prose">
          <p>
            Every claim on this site was checked against the source in this repository,
            and every terminal transcript was produced by running the command. Where the
            code and the design documents disagree, the pages say so in a{' '}
            <strong>Not yet</strong> note rather than describing something that does not
            work.
          </p>
          <p>
            The current set of those, so you can find them quickly:{' '}
            <LinkPreview {...preview('/mcp#transports')}>MCP is stdio only</LinkPreview>,{' '}
            <LinkPreview {...preview('/computers/lifetimes')}>
              the reaper does not sweep containers
            </LinkPreview>
            ,{' '}
            <LinkPreview {...preview('/chat-to-bot/triggers')}>
              Discord, Slack and Telegram triggers are not wired up
            </LinkPreview>
            ,{' '}
            <LinkPreview {...preview('/models#fallback')}>
              husk run ignores fallbackModels
            </LinkPreview>
            , and{' '}
            <LinkPreview {...preview('/reference/sdk')}>
              the SDK targets a different API than the one the server serves
            </LinkPreview>
            .
          </p>
          <p>
            Stuck on something specific? <Link href="/troubleshooting">Troubleshooting</Link>{' '}
            lists the real failure modes with the exact string husk prints for each, and
            the <Link href="/faq">FAQ</Link> answers the rest.
          </p>
        </div>
      </section>
    </main>
  );
}
