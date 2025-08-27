#!/usr/bin/env bash
set -euo pipefail
TOK=$(grep '^HUBSPOT_PRIVATE_APP_TOKEN=' .env | cut -d= -f2- | tr -d '\r')
EMAIL=$(grep '^HUBSPOT_CONTACT_EMAIL=' .env | cut -d= -f2- | tr -d '\r' || true)
test -n "$TOK" || { echo "HUBSPOT_PRIVATE_APP_TOKEN missing"; exit 1; }

NOTE="PROD smoke $(date '+%F %T'): Zoom/Habitica/Chatwork OK"
echo "--- hubspot note ---"
RES=$(curl -sS -X POST "https://api.hubapi.com/crm/v3/objects/notes" \
  -H "Authorization: Bearer ${TOK}" \
  -H "Content-Type: application/json" \
  -d "{\"properties\":{\"hs_note_body\":\"${NOTE//\"/\\\"}\"}}")
echo "$RES" | jq .
NOTE_ID=$(echo "$RES" | jq -r '.id // empty')

if [ -n "$EMAIL" ] && [ -n "$NOTE_ID" ]; then
  echo "--- find contact by email & associate ---"
  CID=$(curl -sS -X POST "https://api.hubapi.com/crm/v3/objects/contacts/search" \
    -H "Authorization: Bearer ${TOK}" \
    -H "Content-Type: application/json" \
    -d "{\"filterGroups\":[{\"filters\":[{\"propertyName\":\"email\",\"operator\":\"EQ\",\"value\":\"$EMAIL\"}]}],\"limit\":1}" \
    | jq -r '.results[0].id // empty')
  if [ -n "$CID" ]; then
    curl -sS -X PUT "https://api.hubapi.com/crm/v3/objects/notes/${NOTE_ID}/associations/contacts/${CID}/note_to_contact" \
      -H "Authorization: Bearer ${TOK}" \
      -H "Content-Type: application/json" \
      -d '{}' | jq .
  else
    echo "[i] contact not found for $EMAIL (note created without association)"
  fi
fi
