#!/usr/bin/env bash
set -euo pipefail
TOKEN=$(grep '^CHATWORK_API_TOKEN=' .env | cut -d= -f2- | tr -d '\r')
ROOM=$(grep '^CHATWORK_ROOM_ID=' .env | cut -d= -f2- | tr -d '\r')
test -n "$TOKEN" || { echo "CHATWORK_API_TOKEN missing"; exit 1; }
test -n "$ROOM" || { echo "CHATWORK_ROOM_ID missing"; exit 1; }

echo "--- chatwork smoke ---"
curl -sS -X POST "https://api.chatwork.com/v2/rooms/${ROOM}/messages" \
  -H "X-ChatWorkToken: ${TOKEN}" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "body=[info][title]PROD smoke[/title]Webhook/Habitica OK : $(date '+%F %T')[/info]" \
  | jq .
