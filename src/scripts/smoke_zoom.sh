#!/usr/bin/env bash
set -euo pipefail

HOST=$(grep '^HOST=' .env | cut -d= -f2- | tr -d '\r' | sed -E 's|^https?://||; s|/+$||')
SECRET=$(grep '^ZOOM_WEBHOOK_SECRET_TOKEN=' .env | cut -d= -f2- | tr -d '\r')

TS=$(date +%s)
CID="sigtest-$(date +%s)"


BODY=$(
  jq -nc --arg cid "$CID" --arg ts_ms "$((TS*1000))" '
  {
    event: "phone.caller_ended",
    event_ts: ($ts_ms|tonumber),
    payload: {
      account_id: "dev",
      owner_id: "SELF",
      object: {
        call_id: $cid,
        direction: "outbound",
        from: "1001",
        to: "1002",
        duration: 61
      }
    }
  }'
)

MSG="v0:$TS:$BODY"
SIG_B64=$(printf '%s' "$MSG" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
SIG_HEX=$(printf '%s' "$MSG" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

echo "[DBG] HOST=$HOST"
echo "[DBG] TS=$TS  CID=$CID"
echo "[DBG] BODY=$(echo "$BODY" | head -c 120)..."
echo "[DBG] SIG_B64_len=$(printf '%s' "$SIG_B64" | wc -c | tr -d " ")  SIG_HEX_len=$(printf '%s' "$SIG_HEX" | wc -c | tr -d " ")"

curl_common=( -sS -i --max-time 12 --connect-timeout 6 -H 'Content-Type: application/json' -H "x-zm-request-timestamp: $TS" --data-binary "$BODY" )

echo "--- try base64 ---"
curl "${curl_common[@]}" -H "x-zm-signature: v0=$SIG_B64" "https://$HOST/webhooks/zoom" | head -n1

echo "--- try hex ---"
curl "${curl_common[@]}" -H "x-zm-signature: v0=$SIG_HEX" "https://$HOST/webhooks/zoom" | head -n1

echo "CID=$CID"
