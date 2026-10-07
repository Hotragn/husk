import Link from "next/link";

import { HuskMark, HuskWordmark } from "@/components/Logo";
import { LinkPreview } from "@/components/LinkPreview";
import { DOCS_URL, LICENCE, REPO_URL } from "@/lib/content";
import { PREVIEWS } from "@/lib/previews";

/**
 * The footer. It existed; this widens it.
 *
 * What changed: the wordmark gets a real size instead of being a lockup the
 * same size as the header's, and the two link lists become four columns that
 * actually reach the docs. Those nine sections were only reachable from the
 * nav's single "Docs" link before, which is one link for thirty-eight pages.
 *
 * The section names and order are the docs site's own `SECTIONS` table — Start
 * here, Computers, Chat to bot, MCP, Models, Security, Guides, Reference,
 * Help. They are duplicated rather than imported because these are two
 * separate Next apps with two separate builds and no shared package; the
 * comment is the contract, and `npm run links` walks them.
 *
 * On the wordmark's shimmer
 * -------------------------
 * There isn't one. A gradient sweeping across the mark forever is motion with
 * no information in it, on the one element of the page that is purely the
 * brand — and `brand/logo/USAGE.md` bans decoration on the mark outright ("no
 * glow, no gradient, no rotation, no bevel"). The mark is allowed to be large,
 * which is the part of the idea that was worth having. What moves here is the
 * underline under a link the reader is pointing at, and nothing else.
 */

/** The docs site's own section table, in its own order. */
const DOC_SECTIONS: Array<{ title: string; href: string }> = [
  { title: "Start here", href: "/start" },
  { title: "Quickstart", href: "/start/quickstart" },
  { title: "Computers", href: "/computers" },
  { title: "Providers", href: "/computers/providers" },
  { title: "Chat to bot", href: "/chat-to-bot/import" },
  { title: "MCP", href: "/mcp" },
];

const DOC_MORE: Array<{ title: string; href: string }> = [
  { title: "Models", href: "/models" },
  { title: "Security", href: "/security" },
  { title: "Isolation", href: "/security/isolation" },
  { title: "Guides", href: "/guides/self-hosting" },
  { title: "Reference", href: "/reference/cli" },
  { title: "husk.yaml", href: "/reference/husk-yaml" },
];

const HELP: Array<{ title: string; href: string }> = [
  { title: "FAQ", href: "/faq" },
  { title: "Troubleshooting", href: "/troubleshooting" },
  { title: "Errors", href: "/reference/errors" },
];

export function SiteFooter() {
  const doc = (href: string) => `${DOCS_URL}${href}`;

  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-brand">
            <span className="footer-lockup">
              <HuskMark size={34} />
              <HuskWordmark height={30} />
            </span>
            <p className="lead" style={{ marginTop: "var(--space-5)", maxWidth: "34ch" }}>
              Your AI chat gets a computer.
            </p>
            <p className="small" style={{ marginTop: "var(--space-3)" }}>
              The name says it: a husk is empty. Every computer starts with nothing
              installed, and there&rsquo;s no account holding anything of yours.
            </p>
          </div>

          <div>
            <h2 className="footer-heading">Product</h2>
            <ul className="footer-list">
              <li>
                <Link href="/">Give your agent a computer</Link>
              </li>
              <li>
                <Link href="/#chat-to-bot">Turn a chat into a bot</Link>
              </li>
              <li>
                <Link href="/#providers">Providers and isolation</Link>
              </li>
              <li>
                <LinkPreview {...PREVIEWS.pricing}>Pricing</LinkPreview>
              </li>
              <li>
                <LinkPreview {...PREVIEWS.manifesto}>Manifesto</LinkPreview>
              </li>
            </ul>
          </div>

          <div>
            <h2 className="footer-heading">Docs</h2>
            <ul className="footer-list">
              {DOC_SECTIONS.map((s) => (
                <li key={s.href}>
                  <a href={doc(s.href)}>{s.title}</a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="footer-heading">Reference</h2>
            <ul className="footer-list">
              {DOC_MORE.map((s) => (
                <li key={s.href}>
                  <a href={doc(s.href)}>{s.title}</a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="footer-heading">Help</h2>
            <ul className="footer-list">
              {HELP.map((s) => (
                <li key={s.href}>
                  <a href={doc(s.href)}>{s.title}</a>
                </li>
              ))}
              <li>
                <a href={REPO_URL} rel="noreferrer noopener">
                  GitHub
                </a>
              </li>
              <li>
                <a
                  href={`${REPO_URL}/blob/main/docs/ARCHITECTURE.md`}
                  rel="noreferrer noopener"
                >
                  Architecture
                </a>
              </li>
              <li>
                <a
                  href={`${REPO_URL}/blob/main/docs/SECURITY-MODEL.md`}
                  rel="noreferrer noopener"
                >
                  Security model
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="footer-legal">
          <p>{LICENCE}.</p>
          <p className="mono">no telemetry. nothing left this machine.</p>
        </div>
      </div>
    </footer>
  );
}
