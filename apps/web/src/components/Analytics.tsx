"use client";

import { useEffect } from "react";

/**
 * Page views and clicks, sent to PostHog (US). The key is a public project
 * token: it ships in every page anyway, so it lives here rather than in a
 * dashboard variable.
 *
 * Only on huskai.dev, so local dev, previews and the old .vercel.app host do
 * not count. What it collects is listed on the docs' /privacy page; keep the
 * two in step. `persistence: "memory"` keeps the visit ID in memory only (no
 * cookie, nothing in localStorage). Everything PostHog could switch on from
 * its dashboard (recording, surveys, heatmaps, extra scripts) is off here, so
 * the page stays true whatever the project settings say. IP addresses are
 * discarded by a PostHog project setting, not by this code.
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
        disable_surveys: true,
        disable_conversations: true,
        disable_product_tours: true,
        disable_external_dependency_loading: true,
        capture_heatmaps: false,
        capture_dead_clicks: false,
        capture_exceptions: false,
        capture_performance: false,
        // Do Not Track and Global Privacy Control both mean nothing is sent.
        respect_dnt: true,
        // Asks PostHog not to look up a location from the IP address.
        before_send: (event) => {
          if (event) event.properties.$geoip_disable = true;
          return event;
        },
      }),
    );
  }, []);
  return null;
}
