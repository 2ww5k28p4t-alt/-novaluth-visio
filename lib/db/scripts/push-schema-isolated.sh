#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "${NOVALUTH_ISOLATED_SCHEMA_CHECK:-}" != "1" ]]; then
  echo "Refusing unreviewed schema force push: use 'pnpm run check-schema:isolated' instead." >&2
  exit 1
fi

if [[ "${NODE_ENV:-}" != "test" ||
  ! "${DATABASE_URL:-}" =~ ^postgresql://schema_check@127\.0\.0\.1:[0-9]+/postgres$ ]]; then
  echo "Refusing schema force push outside the isolated PostgreSQL validation database." >&2
  exit 1
fi

exec drizzle-kit push --force --config ./drizzle.config.ts