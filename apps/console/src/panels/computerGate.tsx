/**
 * What Terminal, Files and Browser show *before* they know whether a machine
 * exists.
 *
 * These three panels are useless without a computer to point at, so each one
 * short-circuits when the list is empty. The bug this exists to prevent: an
 * empty array means two different things — "the server says there are none"
 * and "we have not heard back yet" — and rendering "No computer to browse."
 * for the second is a lie about the server's answer. `ComputersValue.loaded`
 * is the difference, and this is the one place that spends it, so the three
 * panels cannot drift apart again.
 *
 * Returns the element to render instead of the panel, or `null` to carry on.
 */

import type { ReactNode } from 'react';
import { EmptyState, ErrorBlock, PanelHeader, Skeleton, StatusLine } from '../components/primitives';
import type { ComputersValue } from '../state/computers';

export function computerGate({
  computers,
  title,
  lede,
  emptyTitle,
  emptyBody,
}: {
  computers: ComputersValue;
  title: string;
  lede: string;
  emptyTitle: string;
  emptyBody: string;
}): ReactNode | null {
  const { loaded, list, error, loading, showSkeleton, slow, reload } = computers;

  if (loaded && list.length > 0) return null;

  if (error) {
    return (
      <section className="panel">
        <PanelHeader title={title} lede={lede} />
        <ErrorBlock error={error} retry={reload} />
      </section>
    );
  }

  if (!loaded) {
    // Under 400ms, nothing. 400ms–2s, a skeleton. Past 2s, say what we want.
    // UI-PRINCIPLES §6 — and never the empty state, which is not yet true.
    return (
      <section className="panel">
        <PanelHeader title={title} lede={lede} />
        {loading && slow ? <StatusLine text="Listing computers…" /> : null}
        {showSkeleton && !slow ? <Skeleton rows={3} /> : null}
      </section>
    );
  }

  return (
    <section className="panel">
      <PanelHeader title={title} lede={lede} />
      <EmptyState title={emptyTitle} body={emptyBody} command={'husk run "echo hello"'} />
    </section>
  );
}
