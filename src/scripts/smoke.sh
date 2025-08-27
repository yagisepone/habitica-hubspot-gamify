#!/usr/bin/env bash
# scripts/smoke.sh
set -euo pipefail

HOST=$(grep '^HOST=' .env | cut -d= -f2- | tr -d '\r' | sed -E 's|^https?://||; s|/+$||')
SECRET=$(grep '^ZOOM_WEBHOOK_SECRET_TOKEN=' .env | cut -d= -f2- | tr -d '\r')
echo "[i] HOST=https://$HOST  SECRET_len=$(printf %s "$SECRET" | wc -c)"
curl -sS "https://$HOST/healthz" >/dev/null && echo "[ok] healthz"

TS=$(date +%s)
BODY=$(jq -c . <<'JSON'
{"event":"phone.caller_ended","event_ts":0,"payload":{"account_id":"dev","object":{"call_id":"smoke","direction":"outbound","from":"1001","to":"1002","duration":1}}}
JSON
)
BODY=${BODY/\"event_ts\":0/\"event_ts\":$((TS*1000))}
MSG="v0:$TS:$BODY"
SIG_B64=$(printf %s "$MSG" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
SIG_HEX=$(printf %s "$MSG" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

echo "--- try: base64 signature ---"
curl -sS -X POST "https://$HOST/webhooks/zoom" \
  -H 'Content-Type: application/json' \
  -H "x-zm-request-timestamp: $TS" \
  -H "x-zm-signature: v0=$SIG_B64" \
  --data-binary "$BODY" | jq .

echo "--- try: hex signature ---"
curl -sS -X POST "https://$HOST/webhooks/zoom" \
  -H 'Content-Type: application/json' \
  -H "x-zm-request-timestamp: $TS" \
  -H "x-zm-signature: v0=$SIG_HEX" \
  --data-binary "$BODY" | jq .

# Habitica: ToDo作成テスト（任意）
HAB_ID=$(grep '^HABITICA_OWNER_ID=' .env | cut -d= -f2- | tr -d '\r')
HAB_TOKEN=$(grep '^HABITICA_API_TOKEN=' .env | cut -d= -f2- | tr -d '\r')
HAB_CLIENT=$(grep '^HABITICA_X_CLIENT=' .env | cut -d= -f2- | tr -d '\r')
if [[ -n "$HAB_ID" && -n "$HAB_TOKEN" && -n "$HAB_CLIENT" ]]; then
  echo "--- habitica todo ---"
  curl -sS -X POST "https://habitica.com/api/v3/tasks/user" \
    -H "Content-Type: application/json" \
    -H "x-api-user: $HAB_ID" \
    -H "x-api-key:  $HAB_TOKEN" \
    -H "x-client:   $HAB_CLIENT" \
    -d '{"text":"[PROD] smoke","type":"todo"}' | jq '.success,.data.text'
fi
