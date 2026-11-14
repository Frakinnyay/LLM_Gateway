import { useMemo, useState } from 'react';
import { adminApi, tryChat, type CacheStats, type CostBucket, type ProviderStatus, type RequestRow, type TryItResult } from './api';
import { useAuth } from './auth';
import { fmtCost, fmtMs, fmtPercent, fmtTokens, HEALTH_LABEL, scaleBars, shortId } from './format';
import { usePolling } from './usePolling';

const POLL_MS = 3000;

function ErrorNote({ message }: { message: string | null }) {
  return message ? <p className="error" role="alert">Could not refresh: {message}</p> : null;
}

/* ---------------------------- Provider status & controls ---------------------------- */

const FAILURE_MODES = ['none', 'http_500', 'http_503', 'timeout', 'bad_request', 'stream_cut'] as const;

export function ProviderPanel() {
  const { token } = useAuth();
  const api = useMemo(() => adminApi(token), [token]);
  const { data, error, reload } = usePolling((s) => api.providers(s), POLL_MS);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(name); setActionError(null);
    try { await fn(); reload(); } catch (e) { setActionError(e instanceof Error ? e.message : 'action failed'); } finally { setBusy(null); }
  };

  return (
    <section aria-labelledby="providers-h">
      <h2 id="providers-h">Providers</h2>
      <ErrorNote message={error} />
      {actionError && <p className="error" role="alert">{actionError}</p>}
      <div className="cards">
        {data?.data.map((p: ProviderStatus) => (
          <article key={p.name} className={`card health-${p.health}`}>
            <header>
              <strong>{p.name}</strong>
              <span className={`badge ${p.health}`}>{HEALTH_LABEL[p.health]}</span>
            </header>
            <dl>
              <dt>Models</dt><dd>{p.models.join(', ') || '—'}</dd>
              <dt>Circuit</dt>
              <dd>
                {p.circuit.state}
                {p.circuit.consecutiveFailures > 0 && ` · ${p.circuit.consecutiveFailures} failure(s)`}
                {p.circuit.state === 'OPEN' && ` · retry in ${fmtMs(p.circuit.retryAfterMs)}`}
              </dd>
            </dl>
            <div className="actions">
              <button disabled={busy === p.name} onClick={() => act(p.name, () => api.setEnabled(p.name, !p.enabled))}>
                {p.enabled ? 'Disable' : 'Enable'}
              </button>
              {p.name.startsWith('mock') && (
                <label>
                  Failure mode{' '}
                  <select defaultValue="none" disabled={busy === p.name} onChange={(e) => act(p.name, () => api.setFailureMode(p.name, e.target.value))}>
                    {FAILURE_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
              )}
            </div>
          </article>
        ))}
        {!data && !error && <p>Loading…</p>}
      </div>
    </section>
  );
}

/* ---------------------------------- Cache statistics ---------------------------------- */

export function CachePanel() {
  const { token } = useAuth();
  const api = useMemo(() => adminApi(token), [token]);
  const { data, error } = usePolling<CacheStats>((s) => api.cacheStats(24, s), POLL_MS);
  const stat = (label: string, value: string) => (
    <div className="stat"><span className="stat-v">{value}</span><span className="stat-l">{label}</span></div>
  );
  return (
    <section aria-labelledby="cache-h">
      <h2 id="cache-h">Cache <small>(last 24 h)</small></h2>
      <ErrorNote message={error} />
      <div className="stats">
        {stat('Exact cache hits', data ? String(data.exact_hits) : '…')}
        {stat('Semantic cache hits', data ? String(data.semantic_hits) : '…')}
        {stat('Cache misses', data ? String(data.misses) : '…')}
        {stat('Hit rate', data ? fmtPercent(data.hit_rate) : '…')}
        {stat('Est. savings', data ? fmtCost(data.estimated_savings_usd) : '…')}
        {stat('Semantic entries', data ? String(data.semantic_cache_entries) : '…')}
      </div>
      <p className="hint">Hit rate counts only requests that consulted the cache. Savings are estimates from configured pricing.</p>
    </section>
  );
}

/* ------------------------------------- Cost chart ------------------------------------- */

const RANGES = { '24h': { hours: 24, bucket: 'hour' }, '7d': { hours: 168, bucket: 'day' }, '30d': { hours: 720, bucket: 'day' } } as const;

export function CostChart() {
  const { token } = useAuth();
  const api = useMemo(() => adminApi(token), [token]);
  const [range, setRange] = useState<keyof typeof RANGES>('24h');
  const { hours, bucket } = RANGES[range];
  const { data, error } = usePolling((s) => api.costs(hours, bucket, s), 10_000, [hours, bucket]);
  const rows: CostBucket[] = data?.data ?? [];
  const H = 140;
  const spent = scaleBars(rows.map((r) => r.estimated_cost_usd), H);
  const saved = scaleBars(rows.map((r) => r.estimated_savings_usd), H);
  const total = rows.reduce((s, r) => s + r.estimated_cost_usd, 0);
  const totalSaved = rows.reduce((s, r) => s + r.estimated_savings_usd, 0);
  const slot = 100 / Math.max(rows.length, 1);

  return (
    <section aria-labelledby="cost-h">
      <h2 id="cost-h">Estimated cost over time</h2>
      <div className="toolbar">
        {(Object.keys(RANGES) as Array<keyof typeof RANGES>).map((r) => (
          <button key={r} className={r === range ? 'active' : ''} onClick={() => setRange(r)}>{r}</button>
        ))}
        <span className="legend"><i className="sw spent" /> spent {fmtCost(total)} <i className="sw saved" /> saved by cache {fmtCost(totalSaved)}</span>
      </div>
      <ErrorNote message={error} />
      {rows.length === 0 ? (
        <p className="hint">No data in this range yet. Costs appear once requests with known pricing have been logged.</p>
      ) : (
        <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="chart" role="img" aria-label="Estimated cost and cache savings per time bucket">
          {rows.map((r, i) => {
            const x = i * slot;
            return (
              <g key={r.bucket}>
                <title>{`${new Date(r.bucket).toLocaleString()} — spent ${fmtCost(r.estimated_cost_usd)}, saved ${fmtCost(r.estimated_savings_usd)}, ${r.requests} requests`}</title>
                <rect className="bar spent" x={x + slot * 0.1} width={slot * 0.38} y={H - (spent[i] ?? 0)} height={spent[i] ?? 0} />
                <rect className="bar saved" x={x + slot * 0.5} width={slot * 0.38} y={H - (saved[i] ?? 0)} height={saved[i] ?? 0} />
              </g>
            );
          })}
        </svg>
      )}
    </section>
  );
}

/* ------------------------------------ Request table ------------------------------------ */

const CACHE_LABEL: Record<RequestRow['cache_status'], string> = { HIT_EXACT: 'Exact hit', HIT_SEMANTIC: 'Semantic hit', MISS: 'Miss', BYPASS: 'Bypass' };

export function RequestTable() {
  const { token } = useAuth();
  const api = useMemo(() => adminApi(token), [token]);
  const { data, error } = usePolling((s) => api.requests(50, s), POLL_MS);
  return (
    <section aria-labelledby="req-h">
      <h2 id="req-h">Recent requests</h2>
      <ErrorNote message={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Time</th><th>Request ID</th><th>Provider</th><th>Model</th><th>Tokens</th><th>Latency</th><th>Cache</th><th>Status</th><th>Cost</th></tr>
          </thead>
          <tbody>
            {data?.data.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.created_at).toLocaleTimeString()}</td>
                <td title={r.request_id}><code>{shortId(r.request_id)}</code></td>
                <td>{r.provider ?? '—'}{r.fallback_used && <span className="badge fallback" title="Served by a fallback provider">fallback</span>}</td>
                <td>{r.model ?? '—'}{r.streamed && <span className="badge neutral">stream</span>}</td>
                <td>{fmtTokens(r.total_tokens, r.tokens_estimated)}</td>
                <td>{fmtMs(r.latency_ms)}</td>
                <td><span className={`badge cache-${r.cache_status}`}>{CACHE_LABEL[r.cache_status]}</span></td>
                <td><span className={r.status_code >= 400 ? 'bad' : 'ok'} title={r.error_type ?? ''}>{r.status_code}</span></td>
                <td title={r.estimated_savings_usd ? `saved ${fmtCost(r.estimated_savings_usd)}` : ''}>{fmtCost(r.estimated_cost_usd)}</td>
              </tr>
            ))}
            {data && data.data.length === 0 && <tr><td colSpan={9} className="hint">No requests logged yet. Use “Try it” below.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="hint">Rows come from the asynchronous request log, so they can lag by about a second. “~” marks estimated token counts.</p>
    </section>
  );
}

/* ----------------------------------- Try it (demo) ----------------------------------- */

export function TryIt() {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('mock-model');
  const [prompt, setPrompt] = useState('Explain vector databases.');
  const [stream, setStream] = useState(false);
  const [bypass, setBypass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [result, setResult] = useState<TryItResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (): Promise<void> => {
    setBusy(true); setError(null); setResult(null); setText('');
    try { setResult(await tryChat(apiKey, { model, prompt, stream, bypassCache: bypass }, setText)); }
    catch (e) { setError(e instanceof Error ? e.message : 'request failed'); }
    finally { setBusy(false); }
  };

  return (
    <section aria-labelledby="try-h">
      <h2 id="try-h">Try it</h2>
      <p className="hint">Sends a real request through the gateway using a tenant API key (create one with <code>npm run create-tenant -- demo</code>). The key stays in this page’s memory only.</p>
      <div className="form">
        <label>Tenant API key<input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="lgw_…" /></label>
        <label>Model<input value={model} onChange={(e) => setModel(e.target.value)} /></label>
        <label className="wide">Prompt<textarea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} /> stream</label>
        <label className="check"><input type="checkbox" checked={bypass} onChange={(e) => setBypass(e.target.checked)} /> bypass cache (Cache-Control: no-cache)</label>
        <button disabled={busy || !apiKey || !prompt} onClick={() => { void send(); }}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {(text || result) && (
        <div className="output">
          {result && (
            <p>
              <span className={result.status >= 400 ? 'bad' : 'ok'}>HTTP {result.status}</span>{' '}
              {Object.entries(result.headers).map(([k, v]) => <span key={k} className="badge neutral">{k}: {v}</span>)}
            </p>
          )}
          <pre>{text}</pre>
        </div>
      )}
    </section>
  );
}
