export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface ProviderStatus {
  name: string;
  configured: boolean;
  enabled: boolean;
  health: 'healthy' | 'disabled' | 'circuit_open' | 'circuit_half_open';
  circuit: { state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'; consecutiveFailures: number; retryAfterMs: number };
  models: string[];
}

export interface RequestRow {
  id: string;
  request_id: string;
  provider: string | null;
  model: string | null;
  total_tokens: number | null;
  tokens_estimated: boolean;
  latency_ms: number;
  status_code: number;
  cache_status: 'HIT_EXACT' | 'HIT_SEMANTIC' | 'MISS' | 'BYPASS';
  streamed: boolean;
  estimated_cost_usd: number | null;
  estimated_savings_usd: number | null;
  fallback_used: boolean;
  error_type: string | null;
  created_at: string;
}

export interface CacheStats {
  window_hours: number;
  exact_hits: number;
  semantic_hits: number;
  misses: number;
  not_consulted: number;
  estimated_savings_usd: number;
  hit_rate: number | null;
  semantic_cache_entries: number;
}

export interface CostBucket { bucket: string; requests: number; estimated_cost_usd: number; estimated_savings_usd: number }

async function request<T>(token: string, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    ...init,
    signal,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    let message = res.statusText;
    try { message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message; } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, message);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const adminApi = (token: string) => ({
  providers: (s?: AbortSignal) => request<{ data: ProviderStatus[] }>(token, '/api/providers', {}, s),
  setEnabled: (name: string, enabled: boolean) =>
    request<unknown>(token, `/api/providers/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
  setFailureMode: (name: string, mode: string) =>
    request<unknown>(token, `/api/providers/${encodeURIComponent(name)}/failure-mode`, { method: 'POST', body: JSON.stringify({ mode }) }),
  requests: (limit: number, s?: AbortSignal) => request<{ data: RequestRow[] }>(token, `/api/requests?limit=${limit}`, {}, s),
  cacheStats: (hours: number, s?: AbortSignal) => request<CacheStats>(token, `/api/cache/stats?hours=${hours}`, {}, s),
  costs: (hours: number, bucket: 'hour' | 'day', s?: AbortSignal) =>
    request<{ data: CostBucket[]; currency: string }>(token, `/api/costs?hours=${hours}&bucket=${bucket}`, {}, s),
});

export interface TryItResult {
  status: number;
  headers: Record<string, string>;
  text: string;
}

const SHOWN_HEADERS = ['x-request-id', 'x-cache', 'x-cache-type', 'x-semantic-similarity', 'x-provider', 'x-fallback-used', 'x-ratelimit-remaining', 'retry-after'];

/** Sends a chat request through the gateway with a tenant API key (held in memory only). Streams progressively when asked. */
export async function tryChat(
  apiKey: string,
  opts: { model: string; prompt: string; stream: boolean; bypassCache: boolean },
  onText: (partial: string) => void,
): Promise<TryItResult> {
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...(opts.bypassCache ? { 'cache-control': 'no-cache' } : {}) },
    body: JSON.stringify({ model: opts.model, messages: [{ role: 'user', content: opts.prompt }], stream: opts.stream }),
  });
  const headers: Record<string, string> = {};
  for (const h of SHOWN_HEADERS) { const v = res.headers.get(h); if (v) headers[h] = v; }

  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok || !contentType.includes('text/event-stream')) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string }; choices?: Array<{ message?: { content?: string } }> } | null;
    const text = res.ok ? (body?.choices?.[0]?.message?.content ?? '') : `${body?.error?.code ?? 'ERROR'}: ${body?.error?.message ?? res.statusText}`;
    onText(text);
    return { status: res.status, headers, text };
  }

  // SSE: events separated by blank lines; each `data:` line is JSON or [DONE]. A mid-stream failure arrives as {error:{...}}.
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data) as { error?: { code?: string; message?: string }; choices?: Array<{ delta?: { content?: string } }> };
        if (j.error) { text += `\n[stream error: ${j.error.code}]`; } else { text += j.choices?.[0]?.delta?.content ?? ''; }
        onText(text);
      } catch { /* ignore malformed event */ }
    }
  }
  return { status: res.status, headers, text };
}
