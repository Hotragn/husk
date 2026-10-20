"use client";

import { useEffect } from "react";

/**
 * Page views and clicks, sent to PostHog (US). The key is a public project
 * token: it ships in every page anyway, so it lives here rather than in a
 * dashboard variable.
 *
 * Only on huskai.dev, so local dev, previews and the old .vercel.app host do
 * not count. `persistence: "memory"` means no cookie and nothing in
 * localStorage, so there is no banner to show: a visit is counted, a visitor
 * is not followed between visits. No session recording.
 *
 * Imported on mount, so the library is its own chunk and never in the way of
 * the first paint.
 */
export function Analytics() {
  useEffect(() => {
    if (!location.hostname.endsWith("huskai.dev")) return;
    void import("posthog-js").then(({ default: posthog }) =>
      posthog.init("phc_zRvFSnyqESLJk4hQhMGja7XrRgEi6R8HhcwGqMmbV4V5", {
        api_host: "https://us.i.posthog.com",
        defaults: "2026-08-30",
        persistence: "memory",
        person_profiles: "identified_only",
        disable_session_recording: true,
      }),
    );
  }, []);
  return null;
}
