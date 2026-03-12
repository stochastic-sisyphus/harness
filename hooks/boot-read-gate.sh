#!/bin/bash
# boot-read-gate.sh — PreToolUse: blocks Edit/Write/Agent if .harness/boot.json exists but hasn't been read
# Depends on track-reads.sh logging reads to /tmp/claude-reads-{session_id}.log

set -e

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
SESSION=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# Only gate Edit, Write, MultiEdit, Agent tools
case "$TOOL" in
  Edit|Write|MultiEdit|Agent) ;;
  *) exit 0 ;;
esac

BOOT_FILE="${CWD}/.harness/boot.json"

# If no boot.json exists in this project, no enforcement needed
if [ ! -f "$BOOT_FILE" ]; then
  exit 0
fi

READS_LOG="/tmp/claude-reads-${SESSION}.log"

# Check if boot.json has been read this session
if [ -f "$READS_LOG" ] && grep -qF "$BOOT_FILE" "$READS_LOG"; then
  exit 0
fi

# Also check relative path form
if [ -f "$READS_LOG" ] && grep -qF ".harness/boot.json" "$READS_LOG"; then
  exit 0
fi

jq -n '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "Read .harness/boot.json first. The boot artifact contains session context you need before making changes."
  }
}'
