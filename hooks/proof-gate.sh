#!/bin/bash
# Stop hook — runs proof checks before Claude stops.
# Project-aware via .harness/proof.json in the project root.
# If no config found, passes through immediately.

INPUT=$(cat)

STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
[ "$STOP_ACTIVE" = "true" ] && exit 0

CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
[ -z "$CWD" ] && CWD="$PWD"

PROOF_CONFIG="${CWD}/.harness/proof.json"
[ ! -f "$PROOF_CONFIG" ] && exit 0

TEST_CMD=$(jq -r '.testCmd // empty' "$PROOF_CONFIG")
LINT_CMD=$(jq -r '.lintCmd // empty' "$PROOF_CONFIG")
LINT_TARGET=$(jq -r '.lintTarget // empty' "$PROOF_CONFIG")

cd "$CWD" || exit 0

FAILURES=""

if [ -n "$TEST_CMD" ]; then
  TEST_OUT=$(eval "$TEST_CMD" 2>&1 | tail -30)
  if [ $? -ne 0 ]; then
    FAILURES="tests failed:\n${TEST_OUT}"
  fi
fi

if [ -n "$LINT_CMD" ] && [ -n "$LINT_TARGET" ]; then
  LINT_OUT=$(eval "$LINT_CMD $LINT_TARGET --no-fix" 2>&1 | tail -20)
  if [ $? -ne 0 ] && [ -n "$LINT_OUT" ]; then
    FAILURES="${FAILURES:+${FAILURES}\n\n}lint failed:\n${LINT_OUT}"
  fi
fi

if [ -n "$FAILURES" ]; then
  REASON=$(printf "%b" "$FAILURES")
  jq -n --arg reason "$REASON" '{"decision": "block", "reason": $reason}'
  exit 0
fi

exit 0
