import { CircuitBreaker } from '../../packages/providers/src/circuitBreaker';

const make = (over: Partial<{ failureThreshold: number; cooldownMs: number; halfOpenMaxRequests: number }> = {}) => {
  const clock = { t: 0 };
  const transitions: string[] = [];
  const b = new CircuitBreaker({
    failureThreshold: 3, cooldownMs: 1000, halfOpenMaxRequests: 1, ...over,
    now: () => clock.t, onStateChange: (f, t) => transitions.push(`${f}>${t}`),
  });
  return { b, clock, transitions };
};

describe('CircuitBreaker', () => {
  it('stays CLOSED below the failure threshold and resets on success', () => {
    const { b } = make();
    b.onFailure(b.tryAcquire()); b.onFailure(b.tryAcquire());
    expect(b.getState()).toBe('CLOSED');
    b.onSuccess(b.tryAcquire());
    expect(b.snapshot().consecutiveFailures).toBe(0);
    b.onFailure(b.tryAcquire()); b.onFailure(b.tryAcquire());
    expect(b.getState()).toBe('CLOSED'); // success reset the count, so 2 < 3
  });
  it('opens at the threshold and rejects traffic while OPEN', () => {
    const { b } = make({ failureThreshold: 2 });
    b.onFailure(b.tryAcquire()); b.onFailure(b.tryAcquire());
    expect(b.getState()).toBe('OPEN');
    expect(b.tryAcquire().allowed).toBe(false);
    expect(b.snapshot().retryAfterMs).toBe(1000);
  });
  it('moves to HALF_OPEN after the cooldown and limits concurrent probes', () => {
    const { b, clock } = make({ failureThreshold: 1, halfOpenMaxRequests: 2 });
    b.onFailure(b.tryAcquire());
    clock.t = 999; expect(b.tryAcquire().allowed).toBe(false);
    clock.t = 1000;
    const p1 = b.tryAcquire(), p2 = b.tryAcquire(), p3 = b.tryAcquire();
    expect([p1.allowed, p2.allowed, p3.allowed]).toEqual([true, true, false]);
    expect(p1.probe).toBe(true);
    expect(b.getState()).toBe('HALF_OPEN');
  });
  it('closes after a successful probe and re-opens after a failed one', () => {
    const a = make({ failureThreshold: 1 });
    a.b.onFailure(a.b.tryAcquire()); a.clock.t = 1000;
    a.b.onSuccess(a.b.tryAcquire());
    expect(a.transitions).toEqual(['CLOSED>OPEN', 'OPEN>HALF_OPEN', 'HALF_OPEN>CLOSED']);
    const f = make({ failureThreshold: 1 });
    f.b.onFailure(f.b.tryAcquire()); f.clock.t = 1000;
    f.b.onFailure(f.b.tryAcquire());
    expect(f.b.getState()).toBe('OPEN');
    expect(f.b.tryAcquire().allowed).toBe(false); // cooldown restarted
  });
  it('ignores late results from an earlier state (epoch check)', () => {
    const { b } = make({ failureThreshold: 1 });
    const slow = b.tryAcquire();
    b.onFailure(b.tryAcquire());
    expect(b.getState()).toBe('OPEN');
    b.onSuccess(slow); // a stale success must NOT close an OPEN breaker
    expect(b.getState()).toBe('OPEN');
  });
  it('a stale success from before the trip cannot close a recovering (HALF_OPEN) breaker', () => {
    const { b, clock } = make({ failureThreshold: 1 });
    const slow = b.tryAcquire(); // request started while CLOSED, still in flight
    b.onFailure(b.tryAcquire()); // trips OPEN
    clock.t = 1000;
    const probe = b.tryAcquire(); // HALF_OPEN, probe in flight
    expect(b.getState()).toBe('HALF_OPEN');
    b.onSuccess(slow); // old-epoch result must be ignored; only the probe may close the breaker
    expect(b.getState()).toBe('HALF_OPEN');
    b.onSuccess(probe);
    expect(b.getState()).toBe('CLOSED');
  });
  it('a stale failure from before the trip cannot re-open a recovering breaker', () => {
    const { b, clock } = make({ failureThreshold: 1 });
    const slow = b.tryAcquire();
    b.onFailure(b.tryAcquire());
    clock.t = 1000;
    const probe = b.tryAcquire();
    b.onFailure(slow); // ignored
    expect(b.getState()).toBe('HALF_OPEN');
    b.onSuccess(probe);
    expect(b.getState()).toBe('CLOSED');
  });
  it('release() frees a probe slot without judging the provider', () => {
    const { b, clock } = make({ failureThreshold: 1 });
    b.onFailure(b.tryAcquire()); clock.t = 1000;
    const probe = b.tryAcquire();
    expect(b.tryAcquire().allowed).toBe(false);
    b.release(probe);
    expect(b.tryAcquire().allowed).toBe(true);
    expect(b.getState()).toBe('HALF_OPEN');
  });
});
