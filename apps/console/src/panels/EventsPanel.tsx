/**
 * `WS /v1/events`, as it arrives.
 *
 * The socket is opened once by `ConnectionProvider` and its frames drive the
 * rest of the console — a `computer_created` here is what makes the Computers
 * table refetch. This panel is the same feed, shown rather than acted on.
 *
 * The server replays its history on subscribe, so the list is not empty just
 * because the panel was opened late.
 */

import { useMemo, useState } from 'react';
import { useConnection } from '../state/connection';
import { EVENT_TOPICS } from '../api/wire';
import type { EventTopic } from '../api/wire';
import { Badge, Button, EmptyState, FilteredEmptyState, PanelHeader, formatWhen } from '../components/primitives';

export function EventsPanel() {
  const { events, clearEvents, status } = useConnection();
  const [topic, setTopic] = useState<EventTopic | 'all'>('all');

  const filtered = useMemo(
    () => (topic === 'all' ? events : events.filter((e) => e.topic === topic)),
    [events, topic],
  );

  return (
    <section className="panel" aria-labelledby="events-title">
      <PanelHeader
        title="Events"
        lede="The live firehose from WS /v1/events. Newest first."
        actions={
          <>
            <label className="visually-hidden" htmlFor="events-topic">
              Topic
            </label>
            <select
              id="events-topic"
              className="select"
              style={{ width: 'auto' }}
              value={topic}
              onChange={(e) => setTopic(e.target.value as EventTopic | 'all')}
            >
              <option value="all">all topics</option>
              {EVENT_TOPICS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <Button onClick={clearEvents} disabled={events.length === 0}>
              Clear
            </Button>
          </>
        }
      />
      <span id="events-title" className="visually-hidden">
        Events
      </span>

      {events.length === 0 ? (
        <EmptyState
          title={status === 'connected' ? 'Nothing has happened yet.' : 'The event socket is not connected.'}
          body={
            status === 'connected'
              ? 'The socket is subscribed to every topic. Create or stop a computer and the frame will appear here.'
              : 'It reconnects with backoff on its own once the control plane answers again.'
          }
        />
      ) : filtered.length === 0 ? (
        <FilteredEmptyState what="events" onClear={() => setTopic('all')} />
      ) : (
        <div className="table-scroll">
          <table className="data">
            <caption>
              {filtered.length} of {events.length} frames. The buffer keeps the most recent 200.
            </caption>
            <thead>
              <tr>
                <th scope="col">At</th>
                <th scope="col">Topic</th>
                <th scope="col">Type</th>
                <th scope="col">Payload</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => (
                <tr key={`${e.at}-${e.type}-${i}`}>
                  <td className="mono tnum">{formatWhen(e.at)}</td>
                  <td>
                    <Badge>{e.topic ?? '—'}</Badge>
                  </td>
                  <td className="mono">{e.type}</td>
                  <td className="mono">
                    <span className="truncate" title={e.payload === undefined ? '' : JSON.stringify(e.payload)}>
                      {e.payload === undefined ? '—' : JSON.stringify(e.payload)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
