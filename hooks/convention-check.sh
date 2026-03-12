#!/bin/bash
# PostToolUse:Edit|Write advisory — warns when .env.template or .env.example files
# contain empty values (KEY=) without a REPLACE_WITH_ placeholder.
# Always exits 0. Never blocks.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

[ -z "$FILE_PATH" ] && exit 0

case "$FILE_PATH" in
  *.env.template*|*.env.example*) ;;
  *) exit 0 ;;
esac

EMPTY_VARS=$(grep -nE '^[A-Z_][A-Z0-9_]*=\s*$' "$FILE_PATH" 2>/dev/null | grep -v 'REPLACE_WITH_')

if [ -n "$EMPTY_VARS" ]; then
  echo "WARN: convention-check: $FILE_PATH has empty values without REPLACE_WITH_ placeholder:" >&2
  echo "$EMPTY_VARS" >&2
fi

exit 0
