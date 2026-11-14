CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL UNIQUE,
  monthly_token_budget  BIGINT NOT NULL CHECK (monthly_token_budget >= 0),
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Plaintext keys are never stored. key_hash = HMAC-SHA256(pepper, full key), hex.
CREATE TABLE api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_prefix    TEXT NOT NULL UNIQUE,
  key_hash      TEXT NOT NULL,
  label         TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);

-- One row per tenant per calendar month (UTC). period_start = first day of month.
-- Budget enforcement uses an atomic conditional UPDATE on this row (Phase 3).
CREATE TABLE usage_records (
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start   DATE NOT NULL,
  input_tokens   BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens  BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  total_tokens   BIGINT NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period_start)
);

CREATE TABLE request_logs (
  id               BIGSERIAL PRIMARY KEY,
  request_id       TEXT NOT NULL,
  tenant_id        UUID REFERENCES tenants(id) ON DELETE SET NULL,
  api_key_id       UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  provider         TEXT,
  model            TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  total_tokens     INTEGER,
  tokens_estimated BOOLEAN NOT NULL DEFAULT false,
  latency_ms       INTEGER NOT NULL,
  status_code      INTEGER NOT NULL,
  cache_status     TEXT NOT NULL DEFAULT 'MISS' CHECK (cache_status IN ('HIT_EXACT','HIT_SEMANTIC','MISS','BYPASS')),
  streamed         BOOLEAN NOT NULL DEFAULT false,
  estimated_cost_usd NUMERIC(14,8),            -- NULL = pricing unavailable
  fallback_used    BOOLEAN NOT NULL DEFAULT false,
  error_type       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_request_logs_created ON request_logs(created_at DESC);
CREATE INDEX idx_request_logs_tenant_created ON request_logs(tenant_id, created_at DESC);
CREATE INDEX idx_request_logs_request_id ON request_logs(request_id);

-- Embedding dimension is fixed at table creation (384 = common local sentence models).
-- context_hash binds an entry to model + generation params + system prompt, so a semantic
-- match can never cross incompatible contexts (see docs/CACHING.md, Phase 11).
CREATE TABLE semantic_cache (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  context_hash  TEXT NOT NULL,
  model         TEXT NOT NULL,
  prompt_text   TEXT NOT NULL,
  embedding     vector(384) NOT NULL,
  response      JSONB NOT NULL,
  provider      TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  hit_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_semantic_cache_scope ON semantic_cache(tenant_id, context_hash);
CREATE INDEX idx_semantic_cache_expires ON semantic_cache(expires_at);
-- Approximate nearest neighbour index, cosine distance.
CREATE INDEX idx_semantic_cache_embedding ON semantic_cache
  USING hnsw (embedding vector_cosine_ops);

CREATE TABLE provider_configs (
  provider     TEXT PRIMARY KEY,
  enabled      BOOLEAN NOT NULL DEFAULT true,   -- runtime toggle (chaos/demo control)
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT
);

CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at DESC);
