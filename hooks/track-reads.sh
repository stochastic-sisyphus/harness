#!/bin/bash
# PostToolUse:Read — log every file read to a per-session temp file.
# Keyed by session_id so subagents in the same session share the log.
# Always exits 0, never blocks.

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

[ -z "$SESSION_ID" ] || [ -z "$FILE_PATH" ] && exit 0

echo "$FILE_PATH" >> "/tmp/claude-reads-${SESSION_ID}.log"
exit 0
