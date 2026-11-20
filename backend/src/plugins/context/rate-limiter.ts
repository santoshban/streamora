import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Sliding-window limiter: at most `limit` acquisitions start within any
 * `intervalMs` window. Waiters are served in FIFO order.
 */
export class RateLimiter {
  private readonly starts: number[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly limit: number,
    readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  acquire(signal?: AbortSignal): Promise<void> {
    const turn = this.tail.then(() => this.waitForSlot(signal));
    // Keep the queue moving even if this waiter is aborted.
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  private async waitForSlot(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const t = this.now();
      while (this.starts.length > 0 && t - this.starts[0]! >= this.intervalMs) this.starts.shift();
      if (this.starts.length < this.limit) {
        this.starts.push(t);
        return;
      }
      const waitMs = Math.max(1, this.intervalMs - (t - this.starts[0]!));
      await sleep(waitMs, undefined, { signal });
    }
  }
}
