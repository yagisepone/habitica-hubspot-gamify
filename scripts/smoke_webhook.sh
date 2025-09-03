#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE"; set +a
fi

HOST="${HOST:-https://sales-gamify.onrender.com}"
URI="${URI:-/webhooks/hubspot}"
AUTH="${AUTH_TOKEN:-${AUTH:-}}"

# どれか一つに入っていればOK（Signing Secret > App/Client Secret）
SECRET="${HUBSPOT_WEBHOOK_SIGNING_SECRET:-${HUBSPOT_APP_SECRET:-${HUBSPOT_CLIENT_SECRET:-}}}"

if [[ -z "${SECRET:-}" ]]; then
  echo "❌ シークレットが見つかりません（HUBSPOT_WEBHOOK_SIGNING_SECRET / HUBSPOT_APP_SECRET / HUBSPOT_CLIENT_SECRET）" >&2
  exit 1
fi

# ありがちな取り違え注意: UUIDっぽいなら警告
if [[ "$SECRET" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "⚠️  そのSECRETはUUIDっぽいです。HubSpot Webhooks v3 は『アプリのクライアント（またはApp）シークレット』を使います。" >&2
fi

TS=$(date +%s%3N)
BODY='[{"subscriptionType":"deal.propertyChange","propertyName":"dealstage","propertyValue":"appointmentscheduled","objectId":123,"occurredAt":'$TS'}]'
BASE="POST${URI}${BODY}${TS}"
SIG=$(printf %s "$BASE" | openssl dgst -sha256 -hmac "$SECRET" -binary | openssl base64 -A)

echo "→ POST $HOST$URI"
code=$(curl -s -o /tmp/smoke_body.json -w "%{http_code}" -X POST "$HOST$URI" \
  -H "Content-Type: application/json" \
  -H "X-HubSpot-Request-Timestamp: $TS" \
  -H "X-HubSpot-Signature-v3: $SIG" \
  --data "$BODY")

echo "HTTP $code"
cat /tmp/smoke_body.json; echo

if [[ -n "${AUTH:-}" ]]; then
  echo "→ GET $HOST/debug/last"
  curl -s "$HOST/debug/last" -H "Authorization: Bearer $AUTH" | jq .
fi
