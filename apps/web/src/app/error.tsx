"use client";

import { useEffect } from "react";

import { REPO_URL } from "@/lib/content";

/**
 * The route-level error boundary.
 *
 * Errors here are actionable, the way `HuskError` is in the product: say what
 * broke, say what to do, and give the digest — the one string that lets anyone
 * find this occurrence in a log. "Something went wrong" is not a message, it is
 * a shrug with a border.
 *
 * No error reporter is wired in and none will be. The site has no telemetry for
 * the same reason the product has none, so the console and this digest are the
 * whole trail.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The reader cannot see the console; whoever they send this to can.
    console.error("huskai.dev route error", error);
  }, [error]);

  return (
    <main id="main" className="container section">
      <p className="eyebrow">error</p>
      <h1 className="h-section">This page did not render.</h1>
      <div className="prose" style={{ marginTop: "var(--space-6)" }}>
        <p>
          Something in the page threw on the way to your screen. It is a bug in
          this site, not in anything you did, and nothing about your visit was
          recorded — there is no telemetry here to record it with.
        </p>
        {error.digest ? (
          <p>
            Quote this if you report it:{" "}
            <code className="inline">{error.digest}</code>
          </p>
        ) : null}
      </div>

      <div className="hero-actions" style={{ marginTop: "var(--space-8)" }}>
        <button type="button" className="btn btn-primary" onClick={reset}>
          Try again
        </button>
        <a
          className="btn btn-secondary"
          href={`${REPO_URL}/issues/new`}
          rel="noreferrer noopener"
        >
          Report it
        </a>
      </div>
    </main>
  );
}
