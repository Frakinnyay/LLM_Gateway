export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface BreakerOptions {
  failureThreshold: number; // consecutive failures (while CLOSED) that trip the breaker
  cooldownMs: number; // time spent OPEN before a probe is allowed
  halfOpenMaxRequests: number; // concurrent probe requests allowed in HALF_OPEN
  now?: () => number; // injectable clock (tests)
  onStateChange?: (from: BreakerState, to: BreakerState) => void;
}

/** Permit returned by tryAcquire. `epoch` ties a result to the state it started in, so late results from an earlier state are ignored. */
export interface Gate {
  allowed: boolean;
  probe: boolean;
  epoch: number;
}

/**
 * Per-provider circuit breaker (in-process).
 *
 *   CLOSED --N consecutive failures--> OPEN --cooldown--> HALF_OPEN --probe ok--> CLOSED
 *                                                              \--probe fails--> OPEN
 *
 * Concurrency: Node runs this synchronously on one thread, so tryAcquire's check-and-increment is
 * atomic. Requests already in flight when the breaker trips complete normally; their late
 * results carry an old epoch and are ignored, so a stale success cannot close an OPEN breaker
 * and a stale failure cannot re-open a recovering one. State is per gateway process: with N
 * instances each learns about an outage independently (documented tradeoff vs shared state).
 */
export class CircuitBreaker {
  private state: BreakerState = 'CLOSED';
  private epoch = 0;
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probesInFlight = 0;
  private readonly now: () => number;

  constructor(private readonly opts: BreakerOptions) {
    this.now = opts.now ?? Date.now;
  }

  getState(): BreakerState { return this.state; }

  snapshot(): { state: BreakerState; consecutiveFailures: number; retryAfterMs: number } {
    const retryAfterMs = this.state === 'OPEN' ? Math.max(0, this.openedAt + this.opts.cooldownMs - this.now()) : 0;
    return { state: this.state, consecutiveFailures: this.consecutiveFailures, retryAfterMs };
  }

  tryAcquire(): Gate {
    if (this.state === 'OPEN' && this.now() - this.openedAt >= this.opts.cooldownMs) this.transition('HALF_OPEN');
    switch (this.state) {
      case 'CLOSED':
        return { allowed: true, probe: false, epoch: this.epoch };
      case 'HALF_OPEN':
        if (this.probesInFlight < this.opts.halfOpenMaxRequests) {
          this.probesInFlight++;
          return { allowed: true, probe: true, epoch: this.epoch };
        }
        return { allowed: false, probe: false, epoch: this.epoch };
      case 'OPEN':
        return { allowed: false, probe: false, epoch: this.epoch };
    }
  }

  onSuccess(g: Gate): void {
    if (g.epoch !== this.epoch) return;
    if (this.state === 'CLOSED') this.consecutiveFailures = 0;
    else if (this.state === 'HALF_OPEN') this.transition('CLOSED');
  }

  onFailure(g: Gate): void {
    if (g.epoch !== this.epoch) return;
    if (this.state === 'CLOSED') {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.opts.failureThreshold) this.transition('OPEN');
    } else if (this.state === 'HALF_OPEN') {
      this.transition('OPEN');
    }
  }

  /** Frees a probe slot without judging the provider (e.g. the client disconnected). */
  release(g: Gate): void {
    if (g.epoch !== this.epoch) return;
    if (this.state === 'HALF_OPEN' && g.probe && this.probesInFlight > 0) this.probesInFlight--;
  }

  private transition(to: BreakerState): void {
    const from = this.state;
    this.state = to;
    this.epoch++;
    this.consecutiveFailures = 0;
    this.probesInFlight = 0;
    if (to === 'OPEN') this.openedAt = this.now();
    this.opts.onStateChange?.(from, to);
  }
}
