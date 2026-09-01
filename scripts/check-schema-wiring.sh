#!/usr/bin/env bash

set -Eeuo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
replit_file="$repo_root/.replit"
post_merge_file="$repo_root/scripts/post-merge.sh"
isolated_command="pnpm --filter @workspace/db run check-schema:isolated"
wiring_command="check-schema:wiring"

if [[ ! -f "$replit_file" ]]; then
  echo "Schema validation wiring check failed: could not find $replit_file." >&2
  exit 1
fi

workflow_args="$(
  awk '
    $0 == "name = \"db-schema\"" {
      in_validation_workflow = 1
      next
    }
    in_validation_workflow && /^\[\[workflows\.workflow\]\]$/ {
      exit
    }
    in_validation_workflow && /^args = / {
      print
      exit
    }
  ' "$replit_file"
)"

if [[ "$workflow_args" != *"$wiring_command"* ||
  "$workflow_args" != *"$isolated_command"* ]]; then
  echo "Schema validation wiring check failed: the .replit db-schema workflow must run $wiring_command and '$isolated_command'." >&2
  echo "Found workflow args: ${workflow_args:-<missing>}" >&2
  echo "This guard prevents the validation workflow from falling back to the shared-database check-schema command." >&2
  exit 1
fi

if [[ ! -f "$post_merge_file" ]]; then
  echo "Schema validation wiring check failed: could not find $post_merge_file." >&2
  exit 1
fi

post_merge_isolated_lines="$(grep -F "$isolated_command" "$post_merge_file" || true)"
if [[ "$post_merge_isolated_lines" != "$isolated_command" ]]; then
  echo "Schema validation wiring check failed: scripts/post-merge.sh must run '$isolated_command'." >&2
  echo "Found matching lines: ${post_merge_isolated_lines:-<missing>}" >&2
  echo "This guard prevents the post-merge hook from falling back to the shared-database check-schema command." >&2
  exit 1
fi

echo "Schema validation wiring passed: workflow and post-merge hook use isolated PostgreSQL checks."