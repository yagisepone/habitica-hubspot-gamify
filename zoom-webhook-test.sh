#!/usr/bin/env bash
set -euo pipefail

# .env を自動読み込み（KEY=VALUE 形式）
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

HOST="${HOST:-${PUBLIC_BASE_URL:-}}"
if [[ -z "${HOST}" ]]; then
  echo "ERROR: .env に HOST か PUBLIC_BASE_URL を設定してください"; exit 1
fi

usage() {
  cat <<'USAGE'
Usage: ./zoom-webhook-test.sh [plain|sig|bearer|last]

  plain   : URL検証（plainToken 応答）
  sig     : 署名ヘッダ x-zm-signature でPOST（ZOOM_WEBHOOK_SECRET 必須）
  bearer  : Authorization: Bearer でPOST
            （ZOOM_BEARER_TOKEN があれば使用。無ければ ZOOM_WEBHOOK_SECRET→AUTH_TOKEN の順に使用）
  last    : /debug/last の中身を表示（AUTH_TOKEN 必須）
USAGE
}

ACTION="${1:-plain}"
BODY='{"event":"phone.ai_call_summary_changed","payload":{"object":{"start_time":"2025-09-11T01:00:00Z","end_time":"2025-09-11T01:05:00Z","caller_email":"test@example.com"}}}'

case "$ACTION" in
  plain)
    curl -i -X POST "$HOST/webhooks/zoom" \
      -H 'Content-Type: application/json' \
      -d '{"plainToken":"abc"}'
    ;;

  sig)
    if [[ -z "${ZOOM_WEBHOOK_SECRET:-}" ]]; then
      echo "ERROR: .env に ZOOM_WEBHOOK_SECRET を設定してください"; exit 1
    fi
    TS="$(date +%s)"
    if command -v openssl >/dev/null 2>&1; then
      SIG="$(printf '%s' "${TS}${BODY}" | openssl dgst -sha256 -hmac "${ZOOM_WEBHOOK_SECRET}" -binary | openssl base64)"
    else
      SIG="$(node -e "const c=require('crypto');process.stdout.write(c.createHmac('sha256',process.env.S).update(process.env.TS+process.env.B).digest('base64'))" S="$ZOOM_WEBHOOK_SECRET" TS="$TS" B="$BODY")"
    fi
    curl -i -X POST "$HOST/webhooks/zoom" \
      -H 'Content-Type: application/json' \
      -H "x-zm-signature: v0=$TS:$SIG" \
      -d "$BODY"
    ;;

  bearer)
    TOKEN="${ZOOM_BEARER_TOKEN:-${ZOOM_WEBHOOK_SECRET:-${AUTH_TOKEN:-}}}"
    if [[ -z "$TOKEN" ]]; then
      echo "ERROR: .env に ZOOM_BEARER_TOKEN か ZOOM_WEBHOOK_SECRET/AUTH_TOKEN を設定してください"; exit 1
    fi
    curl -i -X POST "$HOST/webhooks/zoom" \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $TOKEN" \
      -d "$BODY"
    ;;

  last)
    if [[ -z "${AUTH_TOKEN:-}" ]]; then
      echo "ERROR: .env に AUTH_TOKEN を設定してください"; exit 1
    fi
    if command -v jq >/dev/null 2>&1; then
      curl -s "$HOST/debug/last" -H "Authorization: Bearer $AUTH_TOKEN" | jq .
    else
      curl -s "$HOST/debug/last" -H "Authorization: Bearer $AUTH_TOKEN"
    fi
    ;;

  *) usage; exit 1 ;;
esac
