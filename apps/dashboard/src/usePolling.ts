import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { useAuth } from './auth';

/**
 * Polls `fn` every `intervalMs` (no WebSockets by design). Pauses while the tab is hidden, aborts in-flight requests on
 * unmount/dependency change, and logs out on 401. `reload()` forces an immediate refresh (e.g. after a toggle).
 */
export function usePolling<T>(fn: (signal: AbortSignal) => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const { logout } = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async (): Promise<void> => {
      if (!document.hidden) {
        try {
          setData(await fnRef.current(ac.signal));
          setError(null);
        } catch (e) {
          if (ac.signal.aborted) return;
          if (e instanceof ApiError && e.status === 401) { logout(); return; }
          setError(e instanceof Error ? e.message : 'request failed');
        }
      }
      if (!ac.signal.aborted) timer = setTimeout(() => { void run(); }, intervalMs);
    };
    void run();
    return () => { ac.abort(); if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, tick, logout, ...deps]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, reload };
}
