# mybrain shell wrapper for fish
# Source this file to enable the preflight health check.
#
# Add to your ~/.config/fish/config.fish:
#   if test -f ~/.claude/mybrain/shell/mybrain.fish
#       source ~/.claude/mybrain/shell/mybrain.fish
#   end
#
# All tunables can be overridden before sourcing:
#   set -gx MYBRAIN_HEALTH_TIMEOUT 60

# ─── Tunables (set only if not already set) ───────────────────────────────────
set -q MYBRAIN_HEALTH_URL        || set -gx MYBRAIN_HEALTH_URL        "http://localhost:8787/health"
set -q MYBRAIN_COMPOSE_FILE      || set -gx MYBRAIN_COMPOSE_FILE      "$HOME/.claude/mybrain/compose.yml"
set -q MYBRAIN_HEALTH_TIMEOUT    || set -gx MYBRAIN_HEALTH_TIMEOUT    120
set -q MYBRAIN_HEALTH_INTERVAL   || set -gx MYBRAIN_HEALTH_INTERVAL   2
set -q MYBRAIN_QUIET             || set -gx MYBRAIN_QUIET             0

# ─── Helpers ──────────────────────────────────────────────────────────────────
function _mybrain_log
    test "$MYBRAIN_QUIET" != "1"; and echo "mybrain: $argv" >&2
end

function _mybrain_healthy
    curl -fsS --max-time 2 "$MYBRAIN_HEALTH_URL" >/dev/null 2>&1
end

# ─── claude() wrapper ─────────────────────────────────────────────────────────
function claude --wraps=claude --description "mybrain preflight wrapper for claude"
    _mybrain_log "checking container health at $MYBRAIN_HEALTH_URL"

    if _mybrain_healthy
        _mybrain_log "container healthy — starting Claude Code"
    else if not docker info >/dev/null 2>&1
        _mybrain_log "docker daemon not reachable — starting Claude Code without brain"
    else
        _mybrain_log "not healthy — starting/restarting container via $MYBRAIN_COMPOSE_FILE"
        docker compose -f "$MYBRAIN_COMPOSE_FILE" up -d >&2

        set elapsed 0
        while test $elapsed -lt $MYBRAIN_HEALTH_TIMEOUT
            if _mybrain_healthy
                test $elapsed -gt 0; and echo "" >&2
                _mybrain_log "healthy after {$elapsed}s — starting Claude Code"
                break
            end
            printf "\rmybrain: waiting for health... %ds / %ds" $elapsed $MYBRAIN_HEALTH_TIMEOUT >&2
            sleep $MYBRAIN_HEALTH_INTERVAL
            set elapsed (math $elapsed + $MYBRAIN_HEALTH_INTERVAL)
        end

        if test $elapsed -ge $MYBRAIN_HEALTH_TIMEOUT
            echo "" >&2
            _mybrain_log "timed out after {$MYBRAIN_HEALTH_TIMEOUT}s — starting Claude Code anyway (brain may be unavailable)"
        end
    end

    command claude $argv
end
