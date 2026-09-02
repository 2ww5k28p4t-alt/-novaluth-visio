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

      recover_isolated_server
    fi
  fi
  rm -rf "$tmp_dir" || true
}

server_pid_is_owned() {
  local pid="$1"
  local command_line

  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  command_line="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)" || return 1

  [[ "$command_line" == *"$data_dir"* ]] &&
    [[ "$command_line" =~ (^|[[:space:]/])(postgres|postmaster)([[:space:]]|$) ]]
}

recover_isolated_server() {
  local recovery_pid
  local attempt
  local recovery_attempts=30

  echo "Attempting bounded ownership-safe PostgreSQL recovery (fallback)." >&2

  if ! recovery_pid="$(sed -n '1p' "$data_dir/postmaster.pid" 2>/dev/null)" ||
    ! server_pid_is_owned "$recovery_pid"; then
    echo "Fallback recovery failed: the isolated PostgreSQL process could not be verified as owned; no signal was sent." >&2
    return 0
  fi

  if ! kill -TERM "$recovery_pid" 2>/dev/null; then
    echo "Fallback recovery could not send SIGTERM to the owned PostgreSQL process." >&2
  fi

  for ((attempt = 0; attempt < recovery_attempts; attempt++)); do
    if ! kill -0 "$recovery_pid" 2>/dev/null; then
      echo "Fallback recovery succeeded: the isolated PostgreSQL server exited after SIGTERM." >&2
      return 0
    fi
    sleep 0.1
  done

  if ! kill -0 "$recovery_pid" 2>/dev/null; then
    echo "Fallback recovery succeeded: the isolated PostgreSQL server exited after SIGTERM." >&2
    return 0
  fi

  if ! server_pid_is_owned "$recovery_pid"; then
    echo "Fallback recovery failed: PostgreSQL ownership could not be re-verified; no further signal was sent." >&2
    return 0
  fi

  echo "Fallback recovery escalating to SIGKILL after the bounded SIGTERM wait." >&2
  if ! kill -KILL "$recovery_pid" 2>/dev/null; then
    echo "Fallback recovery failed: SIGKILL could not be sent to the owned PostgreSQL process." >&2
    return 0
  fi

  for ((attempt = 0; attempt < 10; attempt++)); do
    if ! kill -0 "$recovery_pid" 2>/dev/null; then
      echo "Fallback recovery succeeded: the isolated PostgreSQL server exited after SIGKILL." >&2
      return 0
    fi
    sleep 0.1
  done

  if ! kill -0 "$recovery_pid" 2>/dev/null; then
    echo "Fallback recovery succeeded: the isolated PostgreSQL server exited after SIGKILL." >&2
  else
    echo "Fallback recovery failed: the isolated PostgreSQL server is still running after SIGKILL." >&2
  fi
  return 0
}
trap cleanup EXIT

if ! command -v initdb >/dev/null 2>&1 ||
  ! command -v pg_ctl >/dev/null 2>&1; then
  echo "PostgreSQL client and server tools (initdb and pg_ctl) are required." >&2
  exit 1
fi

mkdir "$socket_dir"

if initdb \
  --auth=trust \
  --encoding=UTF8 \
  --no-locale \
  --username=schema_check \
  --pgdata="$data_dir" \
  >/dev/null; then
  :
else
  initdb_status=$?
  echo "Failed to initialize the isolated PostgreSQL data directory (initdb exit status $initdb_status)." >&2
  exit "$initdb_status"
fi

if pg_ctl \
  --pgdata="$data_dir" \
  --log="$log_file" \
  --options="-h 127.0.0.1 -k $socket_dir -p $port" \
  --timeout=60 \
  --wait \
  start \
  >/dev/null; then
  :
else
  startup_status=$?
  echo "Failed to start the isolated PostgreSQL server (pg_ctl exit status $startup_status)." >&2
  if [[ -f "$log_file" ]]; then
    cat "$log_file" >&2
  fi
  exit "$startup_status"
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
