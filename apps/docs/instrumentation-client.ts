import posthog from 'posthog-js';

/**
 * Page views and clicks, sent to PostHog, set up the way PostHog's Next.js
 * guide does it: this file runs once in the browser before the page becomes
 * interactive, and the project token and host come from the build settings,
 * NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN and NEXT_PUBLIC_POSTHOG_HOST.
 *
 * Without a token, or anywhere but huskai.dev, it sends nothing, so local
 * builds and previews never count. What it collects is listed on /privacy;
 * keep the two in step. `persistence: 'memory'` keeps the visit ID in memory
 * only (no cookie, nothing in localStorage). Everything PostHog could switch
 * on from its dashboard (recording, surveys, heatmaps, extra scripts) is off
 * here, so the page stays true whatever the project settings say. IP addresses
 * are discarded by a PostHog project setting, not by this code.
 */
const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
if (token && location.hostname.endsWith('huskai.dev')) {
  try {
    posthog.init(token, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
      defaults: '2026-08-30',
      persistence: 'memory',
      person_profiles: 'identified_only',
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
    });
  } catch {
    // Counting visits must never break the page.
  }
}
