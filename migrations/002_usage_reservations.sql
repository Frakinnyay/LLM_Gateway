-- Tokens reserved by in-flight requests. Budget check: total_tokens + reserved_tokens + new <= budget.
ALTER TABLE usage_records
  ADD COLUMN reserved_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0);
