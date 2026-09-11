import Link from "next/link";

import { HuskMark, HuskWordmark } from "@/components/Logo";
import { REPO_URL } from "@/lib/content";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-grid">
          <div>
            <span className="lockup" style={{ display: "inline-flex" }}>
              <HuskMark size={28} />
              <HuskWordmark height={18} />
            </span>
            <p
              className="lead"
              style={{ marginTop: "var(--space-4)", maxWidth: "34ch" }}
            >
              Empty by design.
            </p>
            <p className="small" style={{ marginTop: "var(--space-3)" }}>
              A husk is empty, a fresh machine has nothing installed, and there
              is no account holding anything of yours.
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
                <Link href="/pricing">Pricing</Link>
              </li>
            </ul>
          </div>

          <div>
            <h2 className="footer-heading">Read</h2>
            <ul className="footer-list">
              <li>
                <Link href="/manifesto">Manifesto</Link>
              </li>
              <li>
                <a href={REPO_URL} rel="noreferrer noopener">
                  Source
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
          <p>Apache-2.0.</p>
          <p className="mono">no telemetry. nothing left this machine.</p>
        </div>
      </div>
    </footer>
  );
}
