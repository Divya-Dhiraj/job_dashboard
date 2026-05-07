#!/usr/bin/env bash
# install.sh — Mac / Linux one-shot installer for the Job Dashboard.
#
# What it does, in order:
#   1. Confirms `node` (>= 18) OR `docker` is on the PATH.
#   2. Picks up `.env.shared` if present (bundled keys), else `.env.example`,
#      and writes `.env` so the app boots out of the box.
#   3. Asks Docker-or-native, then runs the right startup.
#
# Usage:  bash install.sh           # interactive
#         bash install.sh --docker  # force Docker
#         bash install.sh --native  # force `npm install && npm start`
#
# Re-runs are safe — existing .env is left alone unless you delete it.

set -euo pipefail
cd "$(dirname "$0")"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
say()  { printf "[install] %s\n" "$*"; }
warn() { printf "[install] \033[33m%s\033[0m\n" "$*"; }
die()  { printf "[install] \033[31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

MODE="${1:-}"

# ─── 1. Prepare .env ────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  if [[ -f .env.shared ]]; then
    say "Found .env.shared — using bundled keys."
    cp .env.shared .env
  elif [[ -f .env.example ]]; then
    say "No .env found. Seeding from .env.example."
    say "You'll need to add your ANTHROPIC_API_KEY and APIFY_TOKEN later"
    say "(either edit .env directly or use the in-app Settings page)."
    cp .env.example .env
  else
    die ".env.example missing — your checkout is incomplete."
  fi
else
  say ".env already exists — leaving it alone."
fi

# ─── 2. Pick run mode ───────────────────────────────────────────────────────
have_docker=false
have_node=false
command -v docker >/dev/null 2>&1 && have_docker=true
if command -v node >/dev/null 2>&1; then
  node_major=$(node -p "parseInt(process.versions.node.split('.')[0], 10)")
  [[ "$node_major" -ge 18 ]] && have_node=true
fi

if [[ "$MODE" == "--docker" ]]; then
  $have_docker || die "docker not found on PATH. Install Docker Desktop first."
  RUN=docker
elif [[ "$MODE" == "--native" ]]; then
  $have_node || die "node >= 18 not found. Install Node.js 22 first (https://nodejs.org)."
  RUN=native
else
  if $have_docker && $have_node; then
    bold "How would you like to run the dashboard?"
    echo "  1) Docker  (recommended — no Chromium / sharp headaches)"
    echo "  2) Native  (npm install && npm start)"
    read -r -p "Choice [1/2]: " choice
    case "$choice" in
      2) RUN=native ;;
      *) RUN=docker ;;
    esac
  elif $have_docker; then
    say "Only Docker detected — using Docker."
    RUN=docker
  elif $have_node; then
    say "Only Node detected — using native."
    RUN=native
  else
    die "Need Docker or Node.js >= 18. Install one and re-run."
  fi
fi

# ─── 3. Run ─────────────────────────────────────────────────────────────────
if [[ "$RUN" == "docker" ]]; then
  say "Building + starting via docker compose..."
  docker compose up -d --build
  echo
  bold "Dashboard is starting at http://localhost:3000"
  bold "First boot pulls the embeddings model (~500MB) — give it 60–90s."
  echo
  say "Logs:    docker compose logs -f"
  say "Stop:    docker compose down"
else
  say "Installing npm dependencies (this is the slow step)..."
  npm install
  echo
  bold "Starting the dashboard at http://localhost:3000"
  bold "Press Ctrl-C to stop."
  echo
  npm start
fi
