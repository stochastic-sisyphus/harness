#!/bin/bash
# PreToolUse:Edit|Write|MultiEdit — block edits to files that haven't been read.
# New files (don't exist on disk) are allowed through.
# Fires for subagents too — no agent_id bypass.

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# No path to check — allow
[ -z "$FILE_PATH" ] && exit 0

# New file creation — allow
[ ! -f "$FILE_PATH" ] && exit 0

# File exists — require it to have been read first
LOG="/tmp/claude-reads-${SESSION_ID}.log"

if [ -z "$SESSION_ID" ] || [ ! -f "$LOG" ] || ! grep -qF "$FILE_PATH" "$LOG"; then
  jq -n --arg path "$FILE_PATH" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("Read-before-write: you must Read this file before editing it. File: " + $path)
    }
  }'
  exit 0
fi

exit 0
