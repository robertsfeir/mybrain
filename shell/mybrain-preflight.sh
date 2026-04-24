#!/usr/bin/env sh
# mybrain preflight health check — POSIX sh
# Used by the csh/tcsh wrappers (which cannot define shell functions) and as
# a portable reference implementation. zsh and bash have equivalent logic
# inline in their own wrapper files.
#
# Usage: mybrain-preflight.sh [--quiet]
# Always exits 0 — Claude Code always starts; brain may be unavailable on
# timeout or when Docker is not running.

# ─── Tunables (override in your rc before invoking) ───────────────────────────
MYBRAIN_HEALTH_URL="${MYBRAIN_HEALTH_URL:-http://localhost:8787/health}"
MYBRAIN_COMPOSE_FILE="${MYBRAIN_COMPOSE_FILE:-$HOME/.claude/mybrain/compose.yml}"
MYBRAIN_HEALTH_TIMEOUT="${MYBRAIN_HEALTH_TIMEOUT:-120}"
MYBRAIN_HEALTH_INTERVAL="${MYBRAIN_HEALTH_INTERVAL:-2}"
MYBRAIN_QUIET="${MYBRAIN_QUIET:-0}"

QUIET=0
[ "$1" = "--quiet" ] && QUIET=1
[ "$MYBRAIN_QUIET" = "1" ] && QUIET=1

# Color/animation: enabled when stderr is a TTY and NO_COLOR is unset.
USE_COLOR=0
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  USE_COLOR=1
fi

# _status <ansi-color-code> <message>
# Prints "● mybrain: <message>" with a colored dot when USE_COLOR=1.
# Callers: 32 = green (success/ready), 33 = yellow (warning/fallback), 36 = cyan (in-progress).
_status() {
  [ "$QUIET" = "1" ] && return 0
  if [ "$USE_COLOR" = "1" ]; then
    printf '\033[%sm●\033[0m \033[1mmybrain:\033[0m %s\n' "$1" "$2" >&2
  else
    printf 'mybrain: %s\n' "$2" >&2
  fi
}

_healthy() {
  curl -fsS --max-time 2 "$MYBRAIN_HEALTH_URL" >/dev/null 2>&1
}

# ─── Fast path: already healthy ───────────────────────────────────────────────
if _healthy; then
  _status 32 "healthy — starting Claude Code"
  exit 0
fi

# ─── Docker not running: proceed without brain ────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  _status 33 "docker daemon not reachable — starting Claude Code without brain"
  exit 0
fi

# ─── Start / restart the container ────────────────────────────────────────────
_status 36 "not healthy — starting container via $MYBRAIN_COMPOSE_FILE"
docker compose -f "$MYBRAIN_COMPOSE_FILE" up -d >&2

# ─── Wait for health (Ctrl+C starts Claude anyway, same as timeout) ──────────
trap '{ printf "\r\033[K" >&2; _status 33 "interrupted — starting Claude Code anyway (brain may be unavailable)"; exit 0; }' INT

elapsed=0
frame_idx=0
while [ "$elapsed" -lt "$MYBRAIN_HEALTH_TIMEOUT" ]; do
  if _healthy; then
    [ "$elapsed" -gt 0 ] && printf "\r\033[K" >&2
    _status 32 "ready after ${elapsed}s — starting Claude Code"
    exit 0
  fi
  if [ "$USE_COLOR" = "1" ]; then
    # Animate at ~10fps for MYBRAIN_HEALTH_INTERVAL seconds, then re-check.
    ticks=$((MYBRAIN_HEALTH_INTERVAL * 10))
    tick=0
    while [ "$tick" -lt "$ticks" ]; do
      case $((frame_idx % 8)) in
        0) frame='✻' ;;
        1) frame='✽' ;;
        2) frame='✢' ;;
        3) frame='✳' ;;
        4) frame='✺' ;;
        5) frame='✹' ;;
        6) frame='✶' ;;
        7) frame='✴' ;;
      esac
      printf '\r\033[K\033[36m%s\033[0m Waiting for mybrain… \033[2m(%ds / %ds · \033[0m\033[1;33mCtrl+C\033[0m\033[2m to skip)\033[0m' \
        "$frame" "$elapsed" "$MYBRAIN_HEALTH_TIMEOUT" >&2
      sleep 0.1
      tick=$((tick + 1))
      frame_idx=$((frame_idx + 1))
    done
  else
    printf "\rmybrain: waiting for health... %ds / %ds (Ctrl+C to skip)" "$elapsed" "$MYBRAIN_HEALTH_TIMEOUT" >&2
    sleep "$MYBRAIN_HEALTH_INTERVAL"
  fi
  elapsed=$((elapsed + MYBRAIN_HEALTH_INTERVAL))
done

printf "\r\033[K" >&2
_status 33 "timed out after ${MYBRAIN_HEALTH_TIMEOUT}s — starting Claude Code anyway (brain may be unavailable)"
exit 0
