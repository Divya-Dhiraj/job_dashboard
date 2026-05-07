# install.ps1 — Windows one-shot installer for the Job Dashboard.
#
# What it does, in order:
#   1. Confirms `node` (>= 18) OR `docker` is on the PATH.
#   2. Picks up `.env.shared` if present (bundled keys), else `.env.example`,
#      and writes `.env` so the app boots out of the box.
#   3. Asks Docker-or-native, then runs the right startup.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Mode docker
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Mode native
#
# Re-runs are safe — existing .env is left alone unless you delete it.

param(
    [ValidateSet("", "docker", "native")]
    [string]$Mode = ""
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Say  ($m) { Write-Host "[install] $m" }
function Warn ($m) { Write-Host "[install] $m" -ForegroundColor Yellow }
function Bold ($m) { Write-Host $m -ForegroundColor Cyan }
function Die  ($m) { Write-Host "[install] ERROR: $m" -ForegroundColor Red; exit 1 }

# ─── 1. Prepare .env ────────────────────────────────────────────────────────
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.shared") {
        Say "Found .env.shared — using bundled keys."
        Copy-Item ".env.shared" ".env"
    } elseif (Test-Path ".env.example") {
        Say "No .env found. Seeding from .env.example."
        Say "You'll need to add your ANTHROPIC_API_KEY and APIFY_TOKEN later"
        Say "(either edit .env directly or use the in-app Settings page)."
        Copy-Item ".env.example" ".env"
    } else {
        Die ".env.example missing — your checkout is incomplete."
    }
} else {
    Say ".env already exists — leaving it alone."
}

# ─── 2. Detect Docker / Node ────────────────────────────────────────────────
$haveDocker = $null -ne (Get-Command docker -ErrorAction SilentlyContinue)
$haveNode   = $false
if ($null -ne (Get-Command node -ErrorAction SilentlyContinue)) {
    $nodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
    if ($nodeMajor -ge 18) { $haveNode = $true }
}

# ─── 3. Pick run mode ───────────────────────────────────────────────────────
$run = $null
switch ($Mode) {
    "docker" {
        if (-not $haveDocker) { Die "docker not found on PATH. Install Docker Desktop first." }
        $run = "docker"
    }
    "native" {
        if (-not $haveNode) { Die "node >= 18 not found. Install Node.js 22 first (https://nodejs.org)." }
        $run = "native"
    }
    default {
        if ($haveDocker -and $haveNode) {
            Bold "How would you like to run the dashboard?"
            Write-Host "  1) Docker  (recommended - no Chromium / sharp headaches)"
            Write-Host "  2) Native  (npm install && npm start)"
            $choice = Read-Host "Choice [1/2]"
            $run = if ($choice -eq "2") { "native" } else { "docker" }
        } elseif ($haveDocker) {
            Say "Only Docker detected - using Docker."
            $run = "docker"
        } elseif ($haveNode) {
            Say "Only Node detected - using native."
            $run = "native"
        } else {
            Die "Need Docker or Node.js >= 18. Install one and re-run."
        }
    }
}

# ─── 4. Run ─────────────────────────────────────────────────────────────────
if ($run -eq "docker") {
    Say "Building + starting via docker compose..."
    docker compose up -d --build
    if ($LASTEXITCODE -ne 0) { Die "docker compose failed." }
    Write-Host ""
    Bold "Dashboard is starting at http://localhost:3000"
    Bold "First boot pulls the embeddings model (~500MB) - give it 60-90s."
    Write-Host ""
    Say "Logs:    docker compose logs -f"
    Say "Stop:    docker compose down"
} else {
    Say "Installing npm dependencies (this is the slow step)..."
    npm install
    if ($LASTEXITCODE -ne 0) { Die "npm install failed." }
    Write-Host ""
    Bold "Starting the dashboard at http://localhost:3000"
    Bold "Press Ctrl-C to stop."
    Write-Host ""
    npm start
}
