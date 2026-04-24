#!/usr/bin/env bash
set -e

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
MYBRAIN_PORT="${MYBRAIN_PORT:-8787}"
BRAIN_SCOPE="${BRAIN_SCOPE:-personal}"
MYBRAIN_ASYNC_STORAGE="${MYBRAIN_ASYNC_STORAGE:-false}"

log() { echo "[mybrain] $*"; }

# ─── First-boot: initialize PostgreSQL ────────────────────────────────────────
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  log "First boot — initializing PostgreSQL data directory..."
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  gosu postgres initdb -D "$PGDATA" --auth-host=scram-sha-256 --auth-local=trust -E UTF8 --locale=C

  # Start PG temporarily for schema bootstrap
  gosu postgres postgres -D "$PGDATA" &
  BOOT_PG=$!
  until pg_isready -U postgres -q; do sleep 1; done

  log "Creating mybrain user and database..."
  gosu postgres psql -v ON_ERROR_STOP=1 -U postgres <<-EOSQL
    CREATE USER mybrain WITH PASSWORD 'mybrain';
    CREATE DATABASE mybrain OWNER mybrain;
    \c mybrain
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS ltree;
EOSQL

  log "Applying schema..."
  gosu postgres psql -v ON_ERROR_STOP=1 -U mybrain -d mybrain -f /app/schema.sql

  gosu postgres pg_ctl stop -D "$PGDATA" -m fast -w
  wait $BOOT_PG 2>/dev/null || true
  log "PostgreSQL initialized."
fi

# ─── Start PostgreSQL ─────────────────────────────────────────────────────────
log "Starting PostgreSQL..."
gosu postgres postgres -D "$PGDATA" &
PG=$!
until pg_isready -U mybrain -q; do sleep 1; done
log "PostgreSQL ready."

# ─── Start Ollama ─────────────────────────────────────────────────────────────
log "Starting Ollama..."
# Binds to all container interfaces; the port is NOT published to the host
OLLAMA_KEEP_ALIVE=-1 ollama serve &
OL=$!
until curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; do sleep 1; done
log "Ollama ready."

# ─── Pull model if missing (cached in volume after first pull) ─────────────────
if ! ollama list 2>/dev/null | grep -q "mxbai-embed-large"; then
  log "Pulling mxbai-embed-large (first boot only — this takes a minute)..."
  ollama pull mxbai-embed-large
  log "Model ready."
fi

# ─── Start MCP HTTP server ────────────────────────────────────────────────────
log "Starting MCP server on port ${MYBRAIN_PORT}..."
MCP_TRANSPORT=http \
PORT="$MYBRAIN_PORT" \
DATABASE_URL="postgresql://mybrain:mybrain@127.0.0.1:5432/mybrain" \
EMBEDDING_PROVIDER=ollama \
OLLAMA_HOST=http://127.0.0.1:11434 \
BRAIN_SCOPE="$BRAIN_SCOPE" \
MYBRAIN_ASYNC_STORAGE="$MYBRAIN_ASYNC_STORAGE" \
  node /app/server.mjs &
MCP=$!

# Give the MCP server a moment to bind
sleep 2
log "mybrain is ready — MCP HTTP at http://localhost:${MYBRAIN_PORT}"

# ─── Monitor: exit if any service dies, Docker restart policy takes over ───────
wait -n $PG $OL $MCP
log "A service exited unexpectedly — shutting down for Docker restart..." >&2
kill -TERM $PG $OL $MCP 2>/dev/null
wait
exit 1
