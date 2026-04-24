# mybrain shell wrapper for bash
# Source this file in ~/.bashrc to enable the preflight health check.
#
# Add to your ~/.bashrc:
#   [ -f ~/.claude/mybrain/shell/mybrain.bash ] && source ~/.claude/mybrain/shell/mybrain.bash
#
# Tunables — set these before the source line to override defaults:
#   MYBRAIN_HEALTH_TIMEOUT=60   # max seconds to wait for container
#   MYBRAIN_QUIET=1             # suppress all mybrain output
#   NO_COLOR=1                  # disable ANSI colors and spinner animation
#   source ~/.claude/mybrain/shell/mybrain.bash

# ─── Tunables ─────────────────────────────────────────────────────────────────
: "${MYBRAIN_HEALTH_URL:=http://localhost:8787/health}"
: "${MYBRAIN_COMPOSE_FILE:=$HOME/.claude/mybrain/compose.yml}"
: "${MYBRAIN_HEALTH_TIMEOUT:=120}"
: "${MYBRAIN_HEALTH_INTERVAL:=2}"
: "${MYBRAIN_QUIET:=0}"

# ─── Spinner frames (Claude Code style) ───────────────────────────────────────
_mybrain_spin_frames=('✻' '✽' '✢' '✳' '✺' '✹' '✶' '✴')

# ─── Helpers ──────────────────────────────────────────────────────────────────
_mybrain_healthy() { curl -fsS --max-time 2 "$MYBRAIN_HEALTH_URL" >/dev/null 2>&1; }

# _mybrain_status <ansi-color-code> <message>
# Prints "● mybrain: <message>" with a colored dot when stderr is a TTY.
# Callers: 32 = green (success/ready), 33 = yellow (warning/fallback), 36 = cyan (in-progress).
_mybrain_status() {
  [[ "$MYBRAIN_QUIET" == "1" ]] && return
  if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
    printf '\033[%sm●\033[0m \033[1mmybrain:\033[0m %s\n' "$1" "$2" >&2
  else
    printf 'mybrain: %s\n' "$2" >&2
  fi
}

# ─── claude() wrapper ─────────────────────────────────────────────────────────
claude() {
  local use_color=0
  [[ -t 2 && -z "${NO_COLOR:-}" ]] && use_color=1
  local R=$'\033[0m' DIM=$'\033[2m' BOLD=$'\033[1m' CYAN=$'\033[36m' YEL=$'\033[33m'

  if _mybrain_healthy; then
    _mybrain_status 32 "healthy — starting Claude Code"
  elif ! docker info &>/dev/null; then
    _mybrain_status 33 "docker daemon not reachable — starting Claude Code without brain"
  else
    _mybrain_status 36 "not healthy — starting container via $MYBRAIN_COMPOSE_FILE"
    docker compose -f "$MYBRAIN_COMPOSE_FILE" up -d >&2

    local _mybrain_interrupted=0
    trap '{ printf "\r\033[K" >&2; _mybrain_status 33 "interrupted — starting Claude Code anyway (brain may be unavailable)"; _mybrain_interrupted=1; }' INT

    local elapsed=0 frame_idx=0 tick frame
    while (( elapsed < MYBRAIN_HEALTH_TIMEOUT && _mybrain_interrupted == 0 )); do
      if _mybrain_healthy; then
        (( elapsed > 0 )) && printf "\r\033[K" >&2
        _mybrain_status 32 "ready after ${elapsed}s — starting Claude Code"
        break
      fi
      if (( use_color )); then
        for (( tick=0; tick < MYBRAIN_HEALTH_INTERVAL * 10 && _mybrain_interrupted == 0; tick++ )); do
          frame=${_mybrain_spin_frames[frame_idx % 8]}  # bash arrays are 0-indexed
          printf "\r\033[K${CYAN}%s${R} Waiting for mybrain… ${DIM}(%ds / %ds · ${R}${BOLD}${YEL}Ctrl+C${R}${DIM} to skip)${R}" \
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
      printf "\r\033[K" >&2
      _mybrain_status 33 "timed out after ${MYBRAIN_HEALTH_TIMEOUT}s — starting Claude Code anyway (brain may be unavailable)"
    fi
  fi

  command claude "$@"
}
