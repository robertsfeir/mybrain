# mybrain shell wrapper for bash
# Source this file in ~/.bashrc to enable the preflight health check.
#
# Add to your ~/.bashrc:
#   [ -f ~/.claude/mybrain/shell/mybrain.bash ] && source ~/.claude/mybrain/shell/mybrain.bash
#
# All tunables can be overridden before sourcing:
#   MYBRAIN_HEALTH_TIMEOUT=60
#   source ~/.claude/mybrain/shell/mybrain.bash

# ─── Tunables ─────────────────────────────────────────────────────────────────
: "${MYBRAIN_HEALTH_URL:=http://localhost:8787/health}"
: "${MYBRAIN_COMPOSE_FILE:=$HOME/.claude/mybrain/compose.yml}"
: "${MYBRAIN_HEALTH_TIMEOUT:=120}"
: "${MYBRAIN_HEALTH_INTERVAL:=2}"
: "${MYBRAIN_QUIET:=0}"

# ─── Helpers ──────────────────────────────────────────────────────────────────
_mybrain_log()     { [[ "$MYBRAIN_QUIET" != "1" ]] && echo "mybrain: $*" >&2; }
_mybrain_healthy() { curl -fsS --max-time 2 "$MYBRAIN_HEALTH_URL" >/dev/null 2>&1; }

# ─── claude() wrapper ─────────────────────────────────────────────────────────
claude() {
  _mybrain_log "checking container health at $MYBRAIN_HEALTH_URL"

  if _mybrain_healthy; then
    _mybrain_log "container healthy — starting Claude Code"
  elif ! docker info &>/dev/null; then
    _mybrain_log "docker daemon not reachable — starting Claude Code without brain"
  else
    _mybrain_log "not healthy — starting/restarting container via $MYBRAIN_COMPOSE_FILE"
    docker compose -f "$MYBRAIN_COMPOSE_FILE" up -d >&2

    # Ctrl+C during the wait: print newline and start Claude anyway (same as timeout)
    local _mybrain_interrupted=0
    trap '{ echo "" >&2; _mybrain_log "interrupted — starting Claude Code anyway (brain may be unavailable)"; _mybrain_interrupted=1; }' INT

    local elapsed=0
    while (( elapsed < MYBRAIN_HEALTH_TIMEOUT && _mybrain_interrupted == 0 )); do
      if _mybrain_healthy; then
        [[ $elapsed -gt 0 ]] && echo "" >&2
        _mybrain_log "healthy after ${elapsed}s — starting Claude Code"
        break
      fi
      printf "\rmybrain: waiting for health... %ds / %ds (Ctrl+C to skip)" "$elapsed" "$MYBRAIN_HEALTH_TIMEOUT" >&2
      sleep "$MYBRAIN_HEALTH_INTERVAL"
      (( elapsed += MYBRAIN_HEALTH_INTERVAL ))
    done

    trap - INT  # restore default SIGINT handling

    if (( _mybrain_interrupted == 0 && elapsed >= MYBRAIN_HEALTH_TIMEOUT )); then
      echo "" >&2
      _mybrain_log "timed out after ${MYBRAIN_HEALTH_TIMEOUT}s — starting Claude Code anyway (brain may be unavailable)"
    fi
  fi

  command claude "$@"
}
