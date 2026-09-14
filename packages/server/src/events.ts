export type EventTopic = 'computers' | 'runs' | 'providers' | 'triggers' | 'adapters' | 'reaper';

export interface HuskEvent {
  type: string;
  at: string;
  topic: EventTopic;
  payload: unknown;
}

type Listener = (event: HuskEvent) => void;

/**
 * The firehose behind `WS /v1/events`.
 *
 * Deliberately not an `EventEmitter`: subscribers here are network sockets, and one
 * of them throwing during delivery must not stop the rest of the fan-out or take
 * the process down with an uncaught exception.
 */
export class EventBus {
  private readonly listeners = new Set<Listener>();
  private readonly recent: HuskEvent[] = [];
  private readonly historyLimit: number;

  constructor(opts: { historyLimit?: number } = {}) {
    this.historyLimit = opts.historyLimit ?? 100;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  emit(topic: EventTopic, type: string, payload: unknown = {}): HuskEvent {
    const event: HuskEvent = { type, at: new Date().toISOString(), topic, payload };
    this.recent.push(event);
    if (this.recent.length > this.historyLimit) this.recent.shift();
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // A dead socket must not stop delivery to the live ones.
      }
    }
    return event;
  }

  /** Replayed to a new subscriber so a console that reconnects is not blind. */
  history(topics?: EventTopic[]): HuskEvent[] {
    if (!topics || topics.length === 0) return [...this.recent];
    const set = new Set(topics);
    return this.recent.filter((e) => set.has(e.topic));
  }
}
