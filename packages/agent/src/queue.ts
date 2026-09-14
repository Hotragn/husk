/**
 * A single-consumer async queue.
 *
 * The loop's driver and every concurrently running tool push events from
 * wherever they happen to be; the caller's `for await` pulls them in order.
 * Without this, a tool's `ctx.emit` during a parallel batch has nowhere to go.
 */
export class EventQueue<T> {
  private readonly buffer: T[] = [];
  private waiter: ((v: IteratorResult<T>) => void) | undefined;
  private ended = false;
  /** Runs when the consumer walks away early, so the driver can abort. */
  onAbandon: (() => void) | undefined;

  push(value: T): void {
    if (this.ended) return;
    const w = this.waiter;
    if (w) {
      this.waiter = undefined;
      w({ value, done: false });
      return;
    }
    this.buffer.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const w = this.waiter;
    if (w) {
      this.waiter = undefined;
      w({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiter = resolve;
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.onAbandon?.();
        this.end();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
