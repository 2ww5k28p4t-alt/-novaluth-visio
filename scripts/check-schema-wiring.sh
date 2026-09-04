#!/usr/bin/env bash

set -Eeuo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
replit_file="$repo_root/.replit"
post_merge_file="$repo_root/scripts/post-merge.sh"
isolated_command="pnpm --filter @workspace/db run check-schema:isolated"
wiring_command="check-schema:wiring"
authorized_force_push="lib/db/scripts/push-schema-isolated.sh"
authorized_reviewed_push_manifest="lib/db/package.json"
raw_force_push_pattern='drizzle-kit[[:space:]]+push([[:space:]][^[:space:]]+)*[[:space:]]+--force([[:space:]]|=|$)'
destructive_schema_command_pattern='drizzle-kit[[:space:]]+(push|migrate)([[:space:]]|$)'

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

unauthorized_destructive_commands=()
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

  is_authorized_destructive_match() {
    case "$relative_path" in
      "$authorized_force_push")
        # This wrapper is the only approved route for a disposable forced push.
        if [[ "$match" =~ $raw_force_push_pattern ]]; then
          return 0
        fi
        ;;
      "$authorized_reviewed_push_manifest")
        # The normal package entry point is safe only while its preflight remains
        # immediately before the push command. Do not exempt the whole manifest.
        local line_number="${match%%:*}"
        local line_content
        local reviewed_push_prefix='"push": "pnpm run check-schema:before-push && '
        local reviewed_push_command="drizzle-kit"
        reviewed_push_command+=" push"
        line_content="$(sed -n "${line_number}p" "$candidate")"
        if [[ "$line_content" == *"$reviewed_push_prefix"* &&
          "$line_content" == *"$reviewed_push_command "* ]]; then
          return 0
        fi
        ;;
    esac

    return 1
  }

  while IFS= read -r match; do
    if ! is_authorized_destructive_match; then
      unauthorized_destructive_commands+=("$relative_path:$match")
    fi
  done < <(grep -InE "$destructive_schema_command_pattern" "$candidate" || true)
done < <(tracked_files)

if ((${#unauthorized_destructive_commands[@]} > 0)); then
  echo "Schema validation wiring check failed: destructive Drizzle schema commands must use an approved safety entry point." >&2
  printf 'Unauthorized invocation: %s\n' "${unauthorized_destructive_commands[@]}" >&2
  echo "Route schema application through the reviewed package push or the isolated PostgreSQL wrapper instead." >&2
  exit 1
fi

if ! grep -qE "$raw_force_push_pattern" "$repo_root/$authorized_force_push"; then
  echo "Schema validation wiring check failed: the authorized force-push wrapper no longer contains the expected Drizzle primitive." >&2
  exit 1
fi

echo "Schema validation wiring passed: workflow and post-merge hook use isolated PostgreSQL checks, and no unauthorized destructive schema command exists."
