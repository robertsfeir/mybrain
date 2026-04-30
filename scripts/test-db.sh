#!/usr/bin/env bash
# ADR-0058: Podman-managed ephemeral test database fixture.
#
# Usage:
#   source <(scripts/test-db.sh up)   # bring up container, export MYBRAIN_TEST_DATABASE_URL
#   scripts/test-db.sh down            # destroy container
#
# `up` writes shell-sourceable `export ...` lines to stdout. Diagnostics go
# to stderr so they don't poison the eval. The container is named
# `mybrain-test`, runs `pgvector/pgvector:0.7.1-pg16` on a free local port,
# and is bound to 127.0.0.1 only — there is no path from this script to a
# production host.
#
# After readiness, templates/schema.sql is applied with EMBED_DIM=1536.

set -euo pipefail

CONTAINER_NAME="mybrain-test"
IMAGE="pgvector/pgvector:0.7.1-pg16"
DB_USER="postgres"
DB_PASSWORD="mybrain-test"
DB_NAME="postgres"
EMBED_DIM="${EMBED_DIM:-1536}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SCHEMA_FILE="${REPO_ROOT}/templates/schema.sql"

log() { echo "[test-db] $*" >&2; }

require_podman() {
  if ! command -v podman >/dev/null 2>&1; then
    log "ERROR: podman is not installed or not on PATH."
    exit 1
  fi
}

find_free_port() {
  # Ask the kernel for a free port by binding port 0 in a short-lived python
  # snippet. Falls back to a Bash /dev/tcp probe across a candidate range if
  # python is unavailable.
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
    return
  fi
  # Fallback: scan a range, return the first free port.
  for port in $(seq 54320 54420); do
    if ! (echo > "/dev/tcp/127.0.0.1/${port}") >/dev/null 2>&1; then
      echo "${port}"
      return
    fi
  done
  log "ERROR: could not find a free local port in 54320-54420."
  exit 1
}

container_exists() {
  podman ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"
}

up() {
  require_podman

  if container_exists; then
    log "Container '${CONTAINER_NAME}' already exists. Tearing down first."
    podman rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  fi

  local port
  port="$(find_free_port)"
  log "Starting ${CONTAINER_NAME} on 127.0.0.1:${port} (image: ${IMAGE})"

  podman run -d \
    --name "${CONTAINER_NAME}" \
    -e "POSTGRES_PASSWORD=${DB_PASSWORD}" \
    -e "POSTGRES_USER=${DB_USER}" \
    -e "POSTGRES_DB=${DB_NAME}" \
    -p "127.0.0.1:${port}:5432" \
    "${IMAGE}" >/dev/null

  # Wait for readiness — pg_isready inside the container is the canonical check.
  log "Waiting for PostgreSQL readiness..."
  local attempts=0
  local max_attempts=60
  while ! podman exec "${CONTAINER_NAME}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "${attempts}" -ge "${max_attempts}" ]; then
      log "ERROR: PostgreSQL did not become ready within ${max_attempts}s."
      podman logs "${CONTAINER_NAME}" >&2 || true
      podman rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
      exit 1
    fi
    sleep 1
  done
  log "PostgreSQL ready after ${attempts}s."

  # Apply schema.sql with EMBED_DIM substitution. We do it inside the
  # container with psql to avoid requiring a host-side psql client.
  if [ ! -f "${SCHEMA_FILE}" ]; then
    log "ERROR: schema file not found at ${SCHEMA_FILE}"
    podman rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
    exit 1
  fi

  log "Applying schema.sql (EMBED_DIM=${EMBED_DIM})"
  sed "s/{{EMBED_DIM}}/${EMBED_DIM}/g" "${SCHEMA_FILE}" \
    | podman exec -i "${CONTAINER_NAME}" psql -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 >&2

  local url="postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${port}/${DB_NAME}"
  log "Container ready. URL: ${url}"
  # The only line on stdout — sourceable by the caller.
  echo "export MYBRAIN_TEST_DATABASE_URL='${url}'"
}

down() {
  require_podman
  if container_exists; then
    log "Destroying container '${CONTAINER_NAME}'"
    podman rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  else
    log "No container '${CONTAINER_NAME}' to destroy."
  fi
}

case "${1:-}" in
  up)   up ;;
  down) down ;;
  *)
    echo "Usage: $0 {up|down}" >&2
    exit 2
    ;;
esac
