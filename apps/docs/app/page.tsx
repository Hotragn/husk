import Link from 'next/link';
import type { Metadata } from 'next';
import { Terminal } from '@/components/Terminal';
import { nav } from '@/lib/content';
import { SITE_DESCRIPTION } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Husk documentation',
  description: SITE_DESCRIPTION,
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
          {sections.map((section) => (
            <Link className="section-card" href={section.items[0]?.href ?? '/'} key={section.dir}>
              <span className="section-card-title">
                {section.title}
                <span className="section-card-count">
                  {section.items.length} {section.items.length === 1 ? 'page' : 'pages'}
                </span>
              </span>
              <p className="section-card-body">{section.items[0]?.description}</p>
            </Link>
          ))}
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
            <Link href="/mcp#transports">MCP is stdio only</Link>,{' '}
            <Link href="/computers/lifetimes">the reaper does not sweep containers</Link>,{' '}
            <Link href="/chat-to-bot/triggers">
              Discord, Slack and Telegram triggers are not wired up
            </Link>
            , <Link href="/models#fallback">
              husk run ignores fallbackModels
            </Link>
            , and{' '}
            <Link href="/reference/sdk">
              the SDK targets a different API than the one the server serves
            </Link>
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
