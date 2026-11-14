import type { Config } from '../../config/src';
import { MockProvider } from './mockProvider';
import { OpenAICompatibleProvider } from './openaiCompatible';
import type { LLMProvider } from './types';

/**
 * Builds configured providers from validated config. Base URLs come ONLY from config
 * (never request data) — this is the gateway's SSRF boundary. Business logic depends
 * solely on LLMProvider / ProviderManager.
 */
export function buildProviders(cfg: Config): Map<string, LLMProvider> {
  const m = new Map<string, LLMProvider>();
  if (cfg.MOCK_PROVIDER_ENABLED) {
    // Several independent mock instances (mock, mock-2, ...) so fallback/circuit-breaker demos need no API keys.
    for (let i = 1; i <= cfg.MOCK_PROVIDER_INSTANCES; i++) {
      const name = i === 1 ? 'mock' : `mock-${i}`;
      m.set(name, new MockProvider({ latencyMs: cfg.MOCK_PROVIDER_LATENCY_MS, failureRate: cfg.MOCK_PROVIDER_FAILURE_RATE }, name));
    }
  }
  if (cfg.GROQ_ENABLED) {
    m.set('groq', new OpenAICompatibleProvider('groq', { baseUrl: cfg.GROQ_BASE_URL, apiKey: cfg.GROQ_API_KEY, includeStreamUsage: cfg.STREAM_INCLUDE_USAGE, models: cfg.GROQ_MODELS }));
  }
  if (cfg.GEMINI_ENABLED) {
    m.set('gemini', new OpenAICompatibleProvider('gemini', { baseUrl: cfg.GEMINI_BASE_URL, apiKey: cfg.GEMINI_API_KEY, includeStreamUsage: cfg.STREAM_INCLUDE_USAGE, models: cfg.GEMINI_MODELS }));
  }
  if (cfg.OPENROUTER_ENABLED) {
    m.set('openrouter', new OpenAICompatibleProvider('openrouter', { baseUrl: cfg.OPENROUTER_BASE_URL, apiKey: cfg.OPENROUTER_API_KEY, includeStreamUsage: cfg.STREAM_INCLUDE_USAGE, models: cfg.OPENROUTER_MODELS }));
  }
  return m;
}
