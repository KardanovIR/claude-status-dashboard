#!/usr/bin/env bash
# Posts Claude Code session status to the dashboard.
# Wired to SessionStart, PreToolUse, Stop, Notification, SessionEnd.
# Requires: curl, jq. Requires env: CLAUDE_STATUS_URL. Optional: CLAUDE_STATUS_SECRET.

# Never block Claude on any failure.
trap 'exit 0' ERR

if [[ -z "${CLAUDE_STATUS_URL:-}" ]]; then
  exit 0
fi

payload=$(cat)

event=$(jq -r '.hook_event_name // empty'     <<<"$payload")
session=$(jq -r '.session_id // empty'        <<<"$payload")
cwd=$(jq -r '.cwd // empty'                   <<<"$payload")
tool=$(jq -r '.tool_name // empty'            <<<"$payload")
command=$(jq -r '.tool_input.command // empty' <<<"$payload")
note=$(jq -r '.message // empty'              <<<"$payload")

[[ -z "$session" ]] && exit 0

project=$(basename "${cwd:-$PWD}")
name="$project"
status=""
message=""

truncate() { printf '%s' "$1" | head -c 120; }

base="${CLAUDE_STATUS_URL%/}"
base="${base%/webhook}"

# SessionEnd → delete the card outright
if [[ "$event" == "SessionEnd" ]]; then
  curl -sS --max-time 3 \
    ${CLAUDE_STATUS_SECRET:+-H "x-webhook-secret: $CLAUDE_STATUS_SECRET"} \
    -X DELETE "$base/sessions/$session" >/dev/null 2>&1 || true
  exit 0
fi

case "$event" in
  SessionStart)
    status="idle"; message="Session started"
    ;;
  Notification)
    status="blocked"; message="${note:-Needs input}"
    ;;
  PreToolUse)
    case "$tool" in
      Edit|Write|MultiEdit|NotebookEdit)
        status="coding"; message="$tool"
        ;;
      Bash)
        if [[ "$command" =~ (pytest|jest|vitest|mocha|rspec|phpunit|\<test\>|go[[:space:]]+test|cargo[[:space:]]+test|npm[[:space:]]+(run[[:space:]]+)?test|yarn[[:space:]]+test|pnpm[[:space:]]+test) ]]; then
          status="testing"
        else
          status="coding"
        fi
        message=$(truncate "$command")
        ;;
      Task|WebSearch|WebFetch)
        status="planning"; message="$tool"
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
  Stop)
    status="idle"; message="Waiting for input"
    ;;
  *)
    exit 0
    ;;
esac

body=$(jq -nc \
  --arg id      "$session" \
  --arg name    "$name" \
  --arg status  "$status" \
  --arg message "$message" \
  --arg project "$project" \
  '{session_id:$id, name:$name, status:$status, message:$message, project:$project}')

url="$base/webhook"

if [[ -n "${CLAUDE_STATUS_SECRET:-}" ]]; then
  curl -sS --max-time 3 \
    -H "content-type: application/json" \
    -H "x-webhook-secret: $CLAUDE_STATUS_SECRET" \
    -X POST "$url" \
    -d "$body" >/dev/null 2>&1 || true
else
  curl -sS --max-time 3 \
    -H "content-type: application/json" \
    -X POST "$url" \
    -d "$body" >/dev/null 2>&1 || true
fi

exit 0
