-- Estimated cost avoided by serving from cache (computed from the cached entry's reported usage). NULL = unknown.
ALTER TABLE request_logs ADD COLUMN estimated_savings_usd NUMERIC(14,8);
CREATE INDEX idx_request_logs_cache_created ON request_logs(cache_status, created_at DESC);
