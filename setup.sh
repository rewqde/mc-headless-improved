#!/usr/bin/env bash
# One-command setup for mc-headless-improved (Linux/macOS, Docker required).
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required: https://docs.docker.com/get-docker/" >&2
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — edit it to pick MC_VERSION if needed."
fi

docker compose up -d --build
echo ""
echo "Waiting for the dashboard health endpoint…"
for i in $(seq 1 30); do
  if curl -fsS http://localhost:4202/api/health >/dev/null 2>&1; then
    echo ""
    echo "Dashboard is up: http://localhost:4202"
    echo "1) Create a dashboard password (12+ chars)."
    echo "2) Complete Microsoft login: open the shown link, enter the code."
    echo "   If the code expires, use Retry login — no restart needed."
    echo "3) Connect to your server (only ones whose rules allow this)."
    exit 0
  fi
  printf "."
  sleep 2
done
echo ""
echo "Dashboard did not answer in time. Check: docker logs mc-headless | tail -n 50"
exit 1
