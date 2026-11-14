export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Normalised request passed to providers (already validated; Phase 2 adds the Zod schema). */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  stream?: boolean;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** true when the provider did not report usage and we approximated it. */
  estimated: boolean;
}

export interface ChatResult {
  /** OpenAI-compatible chat.completion body. */
  body: Record<string, unknown>;
  usage: Usage | null; // null = unknown; never invent exact numbers
  model: string;
}

export interface StreamChunk {
  /** Raw OpenAI-style chunk object (serialised to `data: {...}` by the SSE layer). */
  data: Record<string, unknown>;
  /** Present only on a final chunk if the provider reports usage. */
  usage?: Usage;
}

export interface CallContext {
  requestId: string;
  signal: AbortSignal; // carries timeout + client-disconnect cancellation
}

export interface ModelInfo {
  id: string;
}

export interface ProviderHealth {
  name: string;
  configured: boolean;
  reachable: boolean | 'unknown';
}

export type ProviderErrorKind =
  | 'timeout'
  | 'network'
  | 'upstream_5xx'
  | 'rate_limited' // upstream 429
  | 'bad_request'
  | 'auth'
  | 'unsupported_model'
  | 'malformed_response'
  | 'policy'
  | 'client_abort'; // our own caller disconnected; not a provider fault

/** Failures that justify trying the next provider. Others are returned to the client. */
const FALLBACK_ELIGIBLE: ReadonlySet<ProviderErrorKind> = new Set([
  'timeout',
  'network',
  'upstream_5xx',
  'rate_limited',
  'malformed_response',
]);

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
  get fallbackEligible(): boolean {
    return FALLBACK_ELIGIBLE.has(this.kind);
  }
}

export interface LLMProvider {
  readonly name: string;
  isConfigured(): boolean;
  listModels(): ModelInfo[];
  supportsModel(model: string): boolean;
  chatCompletion(req: ChatRequest, ctx: CallContext): Promise<ChatResult>;
  streamChatCompletion(req: ChatRequest, ctx: CallContext): AsyncIterable<StreamChunk>;
  healthCheck(): Promise<ProviderHealth>;
}
