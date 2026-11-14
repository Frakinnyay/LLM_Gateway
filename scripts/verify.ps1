<#
Full local verification for Windows (PowerShell 5.1+ / 7+). Mirrors scripts/verify.sh.
Every step runs; the exit code is non-zero if ANY step failed. A step is only skipped explicitly
(-SkipDocker / -SkipIntegration); a missing tool is a FAILURE, never a silent pass.
  powershell -ExecutionPolicy Bypass -File scripts\verify.ps1 [-SkipDocker] [-SkipIntegration]
STATUS: written but NOT executed (no PowerShell in the authoring environment) - UNVERIFIED.
#>
param([switch]$SkipDocker, [switch]$SkipIntegration)

$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '..')
$results = New-Object System.Collections.ArrayList

function Record([string]$Name, [string]$Status) { [void]$results.Add([pscustomobject]@{ Name = $Name; Status = $Status }) }

function Step([string]$Name, [scriptblock]$Command) {
  Write-Host ""; Write-Host "=== $Name ==="
  $global:LASTEXITCODE = 0
  & $Command
  if ($LASTEXITCODE -eq 0) { Record $Name 'PASS'; return $true }
  Record $Name 'FAIL'; return $false
}
function Skip([string]$Name, [string]$Why) { Write-Host ""; Write-Host "=== $Name === SKIPPED ($Why)"; Record $Name 'SKIPPED' }
function HasDocker { return [bool](Get-Command docker -ErrorAction SilentlyContinue) }

[void](Step 'node >= 20' { $major = [int](node -p "process.versions.node.split('.')[0]"); if ($major -ge 20) { cmd /c "exit 0" } else { cmd /c "exit 1" } })
if (Test-Path 'package-lock.json') { [void](Step 'install dependencies (npm ci)' { npm ci }) } else { [void](Step 'install dependencies (npm install; no lockfile)' { npm install }) }
[void](Step 'lint' { npm run lint })
[void](Step 'typecheck (gateway)' { npm run typecheck })
[void](Step 'typecheck (dashboard)' { npm run typecheck -w apps/dashboard })
[void](Step 'unit tests' { npm test })
[void](Step 'build (gateway)' { npm run build })
[void](Step 'build (dashboard)' { npm run build:dashboard })

if ($SkipIntegration) {
  Skip 'integration tests' '-SkipIntegration'
} elseif (HasDocker) {
  if (Step 'start Postgres + Redis (docker-compose.dev.yml)' { docker compose -f docker-compose.dev.yml up -d --wait }) {
    [void](Step 'integration tests' { npm run test:integration })
    docker compose -f docker-compose.dev.yml down *> $null   # free host ports 5432/6379 for the full stack below
  } else { Record 'integration tests' 'FAIL (infrastructure did not start)' }
} else {
  Record 'integration tests' 'FAIL (docker not found; use -SkipIntegration to skip explicitly)'
}

if ($SkipDocker) {
  Skip 'docker build + compose + smoke test' '-SkipDocker'
} elseif (HasDocker) {
  if (-not (Test-Path '.env')) { node scripts/gen-env.js }
  if (Step 'docker compose up --build' { docker compose up -d --build }) {
    [void](Step 'API smoke test' { node scripts/smoke.js --wait })
  }
  docker compose down -v *> $null
} else {
  Record 'docker build + compose + smoke test' 'FAIL (docker not found; use -SkipDocker to skip explicitly)'
}

Write-Host ""; Write-Host "================ SUMMARY ================"
$failed = $false; $skipped = $false
foreach ($r in $results) {
  '{0,-48} {1}' -f $r.Name, $r.Status | Write-Host
  if ($r.Status -like 'FAIL*') { $failed = $true }
  if ($r.Status -eq 'SKIPPED') { $skipped = $true }
}
if ($failed) { Write-Host 'VERIFICATION FAILED'; exit 1 }
if ($skipped) { Write-Host 'VERIFICATION PASSED WITH EXPLICIT SKIPS (not a full verification)' } else { Write-Host 'VERIFICATION PASSED' }
exit 0
