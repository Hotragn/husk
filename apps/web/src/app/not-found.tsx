import type { Metadata } from "next";
import Link from "next/link";

import { CommandBlock } from "@/components/CodeBlock";
import { REPO_URL } from "@/lib/content";

export const metadata: Metadata = {
  title: "Not found",
  robots: { index: false, follow: true },
};

/**
 * The error anatomy from UI-PRINCIPLES.md §6: the code in mono, the human
 * sentence at body size, and a next action. Never "Something went wrong", and
 * never an illustration where a sentence would do.
 */
export default function NotFound() {
  return (
    <main id="main">
      <section className="container section" style={{ borderTop: 0 }}>
        <div className="grid12">
          <div className="col-7">
            <p className="eyebrow">http 404</p>
            <h1 className="h-page">There is no page at that address.</h1>
            <p className="lead" style={{ marginTop: "var(--space-6)" }}>
              The link was wrong, or the page moved and nothing forwarded it.
              Nothing is broken on your end, and nothing you did caused this.
            </p>

            <h2 className="footer-heading" style={{ marginTop: "var(--space-12)" }}>
              where to go instead
            </h2>
            <ul className="rule-list">
              <li>
                <span className="rl-term">
                  <Link href="/">husk.sh</Link>
                </span>
                <span className="rl-desc">
                  what Husk is, in one screen and one command
                </span>
              </li>
              <li>
                <span className="rl-term">
                  <Link href="/manifesto">/manifesto</Link>
                </span>
                <span className="rl-desc">
                  why an agent needs a sandbox that tells the truth
                </span>
              </li>
              <li>
                <span className="rl-term">
                  <Link href="/pricing">/pricing</Link>
                </span>
                <span className="rl-desc">
                  it is free, and here is why that is not a trick
                </span>
              </li>
              <li>
                <span className="rl-term">
                  <a href={REPO_URL} rel="noreferrer noopener">
                    source
                  </a>
                </span>
                <span className="rl-desc">
                  the docs live next to the code they describe
                </span>
              </li>
            </ul>

            <p className="small" style={{ marginTop: "var(--space-12)" }}>
              Or skip the website entirely. This works whether or not you find
              the page you were looking for:
            </p>
            <div style={{ marginTop: "var(--space-3)", maxWidth: "36rem" }}>
              <CommandBlock command="npx -y @husk-ai/cli doctor" />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
