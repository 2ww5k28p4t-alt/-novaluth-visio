#!/usr/bin/env bash

set -Eeuo pipefail

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/novaluth-schema-check.XXXXXX")"
data_dir="$tmp_dir/data"
socket_dir="$tmp_dir/socket"
log_file="$tmp_dir/postgres.log"
port="$(
  node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      console.log(server.address().port);
      server.close();
    });
  '
)"

cleanup() {
  if [[ -f "$data_dir/postmaster.pid" ]]; then
    local shutdown_output
    local shutdown_status

    if shutdown_output="$(pg_ctl -D "$data_dir" -m immediate stop 2>&1 >/dev/null)"; then
      :
    else
      shutdown_status=$?
      echo "Failed to stop the isolated PostgreSQL server (pg_ctl exit status $shutdown_status)." >&2
      if [[ -n "$shutdown_output" ]]; then
        printf '%s\n' "$shutdown_output" >&2
      fi
    fi
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

if ! command -v initdb >/dev/null 2>&1 ||
  ! command -v pg_ctl >/dev/null 2>&1; then
  echo "PostgreSQL client and server tools (initdb and pg_ctl) are required." >&2
  exit 1
fi

mkdir "$socket_dir"

initdb \
  --auth=trust \
  --encoding=UTF8 \
  --no-locale \
  --username=schema_check \
  --pgdata="$data_dir" \
  >/dev/null

if ! pg_ctl \
  --pgdata="$data_dir" \
  --log="$log_file" \
  --options="-h 127.0.0.1 -k $socket_dir -p $port" \
  --timeout=60 \
  --wait \
  start \
  >/dev/null; then
  cat "$log_file" >&2
  exit 1
fi

database_url="postgresql://schema_check@127.0.0.1:$port/postgres"

echo "Applying the current Drizzle schema to an isolated PostgreSQL database..."
DATABASE_URL="$database_url" NODE_ENV=test pnpm run push-force

echo "Running the schema preflight against the isolated database..."
DATABASE_URL="$database_url" NODE_ENV=test pnpm run check-schema

echo "Isolated PostgreSQL schema validation passed."

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if (($# > 0)); then
  echo "Running the requested command against the isolated PostgreSQL database..."
  set +e
  DATABASE_URL="$database_url" NODE_ENV=test "$@"
  command_status=$?
  set -e

  cleanup || true
  trap - EXIT
  exit "$command_status"
fi
