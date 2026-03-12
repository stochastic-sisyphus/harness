#!/bin/bash
# install-hooks.sh — copy harness hooks to ~/.claude/hooks/ and merge settings
# Idempotent. Safe to run multiple times.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_SRC="${REPO_ROOT}/hooks"
HOOKS_DEST="${HOME}/.claude/hooks"
SETTINGS="${HOME}/.claude/settings.json"
FRAGMENT="${HOOKS_SRC}/settings-fragment.json"

echo "Installing harness hooks..."

mkdir -p "$HOOKS_DEST"

for script in track-reads.sh read-before-write.sh proof-gate.sh convention-check.sh; do
  cp "${HOOKS_SRC}/${script}" "${HOOKS_DEST}/${script}"
  chmod +x "${HOOKS_DEST}/${script}"
  echo "  copied: ${script}"
done

if [ ! -f "$SETTINGS" ]; then
  echo "  no settings.json found — skipping merge"
  exit 0
fi

if ! command -v jq &>/dev/null; then
  echo "  WARN: jq not found — skipping settings merge"
  exit 0
fi

MERGED=$(jq -s '
  .[0] as $existing |
  .[1].hooks as $new_hooks |
  reduce ($new_hooks | to_entries[]) as $entry (
    $existing;
    . as $doc |
    $entry.key as $event |
    $entry.value as $new_entries |
    ($doc.hooks[$event] // []) as $existing_entries |
    ($existing_entries | map(.hooks[0].command) | sort) as $existing_cmds |
    ($new_entries | map(select(.hooks[0].command as $c | $existing_cmds | index($c) == null))) as $to_add |
    .hooks[$event] = ($existing_entries + $to_add)
  )
' "$SETTINGS" "$FRAGMENT")

echo "$MERGED" > "$SETTINGS"
echo "  merged hooks into ${SETTINGS}"
echo "Done."
