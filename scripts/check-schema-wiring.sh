#!/usr/bin/env bash

set -Eeuo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
replit_file="$repo_root/.replit"
post_merge_file="$repo_root/scripts/post-merge.sh"
isolated_command="pnpm --filter @workspace/db run check-schema:isolated"
wiring_command="check-schema:wiring"
authorized_force_push="lib/db/scripts/push-schema-isolated.sh"
raw_force_push_pattern='drizzle-kit[[:space:]]+push([[:space:]][^[:space:]]+)*[[:space:]]+--force([[:space:]]|=|$)'

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

unauthorized_force_pushes=()
tracked_files() {
  if git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$repo_root" ls-files -z
    return
  fi

  find "$repo_root" \
    \( -type d \( \
      -name .git -o \
      -name node_modules -o \
      -name dist -o \
      -name build -o \
      -name coverage -o \
      -name .agents -o \
      -name .local \
    \) -prune \) -o \
    \( -type f -print0 \)
}

while IFS= read -r -d '' tracked_path; do
  if [[ "$tracked_path" == /* ]]; then
    candidate="$tracked_path"
  else
    candidate="$repo_root/$tracked_path"
  fi
  relative_path="${candidate#"$repo_root"/}"

  case "$relative_path" in
    "$authorized_force_push")
      continue
      ;;
    .agents/* | .local/* | attached_assets/* | docs/* | */node_modules/* | */dist/* | */build/* | */coverage/*)
      continue
      ;;
  esac

  if [[ ! -f "$candidate" ]]; then
    continue
  fi

  while IFS= read -r match; do
    unauthorized_force_pushes+=("$relative_path:$match")
  done < <(grep -InE "$raw_force_push_pattern" "$candidate" || true)
done < <(tracked_files)

if ((${#unauthorized_force_pushes[@]} > 0)); then
  echo "Schema validation wiring check failed: raw 'drizzle-kit push --force' invocations are only allowed in $authorized_force_push." >&2
  printf 'Unauthorized invocation: %s\n' "${unauthorized_force_pushes[@]}" >&2
  echo "Route forced schema application through the isolated PostgreSQL wrapper instead." >&2
  exit 1
fi

if ! grep -qE "$raw_force_push_pattern" "$repo_root/$authorized_force_push"; then
  echo "Schema validation wiring check failed: the authorized force-push wrapper no longer contains the expected Drizzle primitive." >&2
  exit 1
fi

echo "Schema validation wiring passed: workflow and post-merge hook use isolated PostgreSQL checks, and no unauthorized raw force push exists."
