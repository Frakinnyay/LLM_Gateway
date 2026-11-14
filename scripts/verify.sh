#!/usr/bin/env bash
# Full local verification. Every step is run; the exit code is non-zero if ANY step failed.
# A step can only be skipped explicitly (--skip-docker); a missing tool is a FAILURE, never a silent pass.
#   bash scripts/verify.sh [--skip-docker] [--skip-integration]
set -u
cd "$(dirname "$0")/.."

SKIP_DOCKER=0; SKIP_INTEGRATION=0
for a in "$@"; do case "$a" in --skip-docker) SKIP_DOCKER=1 ;; --skip-integration) SKIP_INTEGRATION=1 ;; *) echo "unknown option: $a"; exit 2 ;; esac; done

declare -a NAMES=() RESULTS=()
record() { NAMES+=("$1"); RESULTS+=("$2"); }
step() { # step "name" command...
  local name="$1"; shift
  echo; echo "=== $name ==="
  if "$@"; then record "$name" PASS; else record "$name" FAIL; return 1; fi
}
skip() { echo; echo "=== $1 === SKIPPED ($2)"; record "$1" "SKIPPED"; }

step "node >= 20" bash -c 'node -e "process.exit(Number(process.versions.node.split(\".\")[0])>=20?0:1)"'
if [ -f package-lock.json ]; then step "install dependencies (npm ci)" npm ci; else step "install dependencies (npm install; no lockfile)" npm install; fi
step "lint" npm run lint
step "typecheck (gateway)" npm run typecheck
step "typecheck (dashboard)" npm run typecheck -w apps/dashboard
step "unit tests" npm test
step "build (gateway)" npm run build
step "build (dashboard)" npm run build:dashboard

if [ "$SKIP_INTEGRATION" = 1 ]; then
  skip "integration tests" "--skip-integration"
elif command -v docker >/dev/null 2>&1; then
  if step "start Postgres + Redis (docker-compose.dev.yml)" docker compose -f docker-compose.dev.yml up -d --wait; then
    step "integration tests" npm run test:integration
    docker compose -f docker-compose.dev.yml down >/dev/null 2>&1 # free host ports 5432/6379 for the full stack below
  else
    record "integration tests" "FAIL (infrastructure did not start)"
  fi
else
  record "integration tests" "FAIL (docker not found; use --skip-integration to skip explicitly)"
fi

if [ "$SKIP_DOCKER" = 1 ]; then
  skip "docker build + compose + smoke test" "--skip-docker"
elif command -v docker >/dev/null 2>&1; then
  [ -f .env ] || node scripts/gen-env.js
  if step "docker compose up --build" docker compose up -d --build; then
    step "API smoke test" node scripts/smoke.js --wait
    docker compose down -v >/dev/null 2>&1
  else
    docker compose down -v >/dev/null 2>&1
  fi
else
  record "docker build + compose + smoke test" "FAIL (docker not found; use --skip-docker to skip explicitly)"
fi

echo; echo "================ SUMMARY ================"
FAILED=0
for i in "${!NAMES[@]}"; do printf '%-45s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}"; case "${RESULTS[$i]}" in FAIL*) FAILED=1 ;; esac; done
if [ "$FAILED" = 1 ]; then echo "VERIFICATION FAILED"; exit 1; fi
if printf '%s\n' "${RESULTS[@]}" | grep -q SKIPPED; then echo "VERIFICATION PASSED WITH EXPLICIT SKIPS (not a full verification)"; else echo "VERIFICATION PASSED"; fi
exit 0
