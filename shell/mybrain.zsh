# mybrain shell wrapper for zsh
# Source this file in ~/.zshrc to enable the preflight health check.
#
# Add to your ~/.zshrc:
#   [ -f ~/.claude/mybrain/shell/mybrain.zsh ] && source ~/.claude/mybrain/shell/mybrain.zsh
#
# All tunables can be overridden before sourcing:
#   MYBRAIN_HEALTH_TIMEOUT=60
#   source ~/.claude/mybrain/shell/mybrain.zsh

# ─── Tunables ─────────────────────────────────────────────────────────────────
: "${MYBRAIN_HEALTH_URL:=http://localhost:8787/health}"
: "${MYBRAIN_COMPOSE_FILE:=$HOME/.claude/mybrain/compose.yml}"
: "${MYBRAIN_HEALTH_TIMEOUT:=120}"   # seconds to wait for container health
: "${MYBRAIN_HEALTH_INTERVAL:=2}"    # seconds between health polls
: "${MYBRAIN_QUIET:=0}"              # set to 1 to silence all mybrain output

# ─── Spinner frames (Claude Code style) ───────────────────────────────────────
_mybrain_spin_frames=('✻' '✽' '✢' '✳' '✺' '✹' '✶' '✴')

# ─── Helpers ──────────────────────────────────────────────────────────────────
_mybrain_log()     { [[ "$MYBRAIN_QUIET" != "1" ]] && print "mybrain: $*" >&2 }
_mybrain_healthy() { curl -fsS --max-time 2 "$MYBRAIN_HEALTH_URL" >/dev/null 2>&1 }

# _mybrain_status <ansi-color-code> <message> — prints "● mybrain: <message>"
# Green dot (32) for success, yellow (33) for fallback/warning.
_mybrain_status() {
  [[ "$MYBRAIN_QUIET" == "1" ]] && return
  if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
    printf '\e[%sm●\e[0m \e[1mmybrain:\e[0m %s\n' "$1" "$2" >&2
  else
    printf 'mybrain: %s\n' "$2" >&2
  fi
}

# ─── claude() wrapper ─────────────────────────────────────────────────────────
claude() {
  local use_color=0
  [[ -t 2 && -z "${NO_COLOR:-}" ]] && use_color=1
  local R=$'\e[0m' DIM=$'\e[2m' BOLD=$'\e[1m' CYAN=$'\e[36m' YEL=$'\e[33m'

  _mybrain_log "checking container health at $MYBRAIN_HEALTH_URL"

  if _mybrain_healthy; then
    _mybrain_status 32 "healthy — starting Claude Code"
  elif ! docker info &>/dev/null; then
    _mybrain_status 33 "docker daemon not reachable — starting Claude Code without brain"
  else
    _mybrain_log "not healthy — starting/restarting container via $MYBRAIN_COMPOSE_FILE"
    docker compose -f "$MYBRAIN_COMPOSE_FILE" up -d >&2

    # Ctrl+C during the wait: clear the spinner line, log, and fall through to command claude.
    local _mybrain_interrupted=0
    trap '{ printf "\r\e[K" >&2; _mybrain_status 33 "interrupted — starting Claude Code anyway (brain may be unavailable)"; _mybrain_interrupted=1; }' INT

    local elapsed=0 frame_idx=0 tick frame
    while (( elapsed < MYBRAIN_HEALTH_TIMEOUT && _mybrain_interrupted == 0 )); do
      if _mybrain_healthy; then
        (( elapsed > 0 )) && printf "\r\e[K" >&2
        _mybrain_status 32 "ready after ${elapsed}s — starting Claude Code"
        break
      fi
      if (( use_color )); then
        # Animate at ~10fps for MYBRAIN_HEALTH_INTERVAL seconds, then re-check health.
        for (( tick=0; tick < MYBRAIN_HEALTH_INTERVAL * 10 && _mybrain_interrupted == 0; tick++ )); do
          frame=${_mybrain_spin_frames[$(( (frame_idx % 8) + 1 ))]}
          printf "\r\e[K${CYAN}%s${R} Waiting for mybrain… ${DIM}(%ds / %ds · ${R}${BOLD}${YEL}Ctrl+C${R}${DIM} to skip)${R}" \
            "$frame" "$elapsed" "$MYBRAIN_HEALTH_TIMEOUT" >&2
          sleep 0.1
          (( frame_idx++ ))
        done
      else
        printf "\rmybrain: waiting for health... %ds / %ds (Ctrl+C to skip)" "$elapsed" "$MYBRAIN_HEALTH_TIMEOUT" >&2
        sleep "$MYBRAIN_HEALTH_INTERVAL"
      fi
      (( elapsed += MYBRAIN_HEALTH_INTERVAL ))
    done

    trap - INT  # restore default SIGINT handling

    if (( _mybrain_interrupted == 0 && elapsed >= MYBRAIN_HEALTH_TIMEOUT )); then
      printf "\r\e[K" >&2
      _mybrain_status 33 "timed out after ${MYBRAIN_HEALTH_TIMEOUT}s — starting Claude Code anyway (brain may be unavailable)"
    fi
  fi

  command claude "$@"
}
