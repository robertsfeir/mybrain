# mybrain shell wrapper for tcsh
# Source this file in ~/.tcshrc to enable the preflight health check.
#
# Add to your ~/.tcshrc:
#   if ( -f ~/.claude/mybrain/shell/mybrain.tcsh ) source ~/.claude/mybrain/shell/mybrain.tcsh
#
# Tunables — set before sourcing:
#   setenv MYBRAIN_HEALTH_TIMEOUT 60

if ( ! $?MYBRAIN_HEALTH_URL )        setenv MYBRAIN_HEALTH_URL        "http://localhost:8787/health"
if ( ! $?MYBRAIN_COMPOSE_FILE )      setenv MYBRAIN_COMPOSE_FILE      "$HOME/.claude/mybrain/compose.yml"
if ( ! $?MYBRAIN_HEALTH_TIMEOUT )    setenv MYBRAIN_HEALTH_TIMEOUT    120
if ( ! $?MYBRAIN_HEALTH_INTERVAL )   setenv MYBRAIN_HEALTH_INTERVAL   2
if ( ! $?MYBRAIN_QUIET )             setenv MYBRAIN_QUIET             0

# tcsh cannot define shell functions; delegate to the POSIX preflight script.
alias claude 'sh ~/.claude/mybrain/shell/mybrain-preflight.sh && \claude \!*'
