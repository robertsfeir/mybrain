#!/usr/bin/env sh
# mybrain preflight health check — POSIX sh
# Sources of truth: all shell wrappers delegate the check/wait logic here.
#
# Usage: mybrain-preflight.sh [--quiet]
# Exit 0 = container healthy (or docker unavailable, proceed anyway)
# Exit 1 = timed out waiting for health

# ─── Tunables (override in your rc before sourcing the wrapper) ───────────────
MYBRAIN_HEALTH_URL="${MYBRAIN_HEALTH_URL:-http://localhost:8787/health}"
MYBRAIN_COMPOSE_FILE="${MYBRAIN_COMPOSE_FILE:-$HOME/.claude/mybrain/compose.yml}"
MYBRAIN_HEALTH_TIMEOUT="${MYBRAIN_HEALTH_TIMEOUT:-120}"
MYBRAIN_HEALTH_INTERVAL="${MYBRAIN_HEALTH_INTERVAL:-2}"
MYBRAIN_QUIET="${MYBRAIN_QUIET:-0}"

QUIET=0
[ "$1" = "--quiet" ] && QUIET=1
[ "$MYBRAIN_QUIET" = "1" ] && QUIET=1

_log() {
  [ "$QUIET" = "0" ] && printf "mybrain: %s\n" "$*" >&2
}

_healthy() {
  curl -fsS --max-time 2 "$MYBRAIN_HEALTH_URL" >/dev/null 2>&1
}

# ─── Fast path: already healthy ───────────────────────────────────────────────
_log "checking container health at $MYBRAIN_HEALTH_URL"
if _healthy; then
  _log "container healthy — starting Claude Code"
  exit 0
fi

# ─── Docker not running: proceed without brain ────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  _log "docker daemon not reachable — starting Claude Code without brain"
  exit 0
fi

# ─── Start / restart the container ────────────────────────────────────────────
_log "not healthy — starting/restarting container via $MYBRAIN_COMPOSE_FILE"
docker compose -f "$MYBRAIN_COMPOSE_FILE" up -d >&2

# ─── Wait for health ──────────────────────────────────────────────────────────
elapsed=0
while [ "$elapsed" -lt "$MYBRAIN_HEALTH_TIMEOUT" ]; do
  if _healthy; then
    [ "$elapsed" -gt 0 ] && printf "\n" >&2
    _log "healthy after ${elapsed}s — starting Claude Code"
    exit 0
  fi
  printf "\rmybrain: waiting for health... %ds / %ds" "$elapsed" "$MYBRAIN_HEALTH_TIMEOUT" >&2
  sleep "$MYBRAIN_HEALTH_INTERVAL"
  elapsed=$((elapsed + MYBRAIN_HEALTH_INTERVAL))
done

printf "\n" >&2
_log "timed out after ${MYBRAIN_HEALTH_TIMEOUT}s — starting Claude Code anyway (brain may be unavailable)"
exit 0
