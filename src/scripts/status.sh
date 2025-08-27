# scripts/status.sh
#!/usr/bin/env bash
set -euo pipefail

echo "=== ENV CHECK ==="
for k in HOST TZ PORT HABITICA_OWNER_ID HABITICA_API_TOKEN HABITICA_X_CLIENT CHATWORK_API_TOKEN CHATWORK_ROOM_ID HUBSPOT_PRIVATE_APP_TOKEN HUBSPOT_CONTACT_EMAIL; do
  v=$(grep -E "^$k=" .env | cut -d= -f2- | tr -d '\r' || true)
  printf "%-26s : %s\n" "$k" "${v:+(set)}"
done
echo

HOST=$(grep '^HOST=' .env | cut -d= -f2- | tr -d '\r' | sed -E 's|^https?://||; s|/+$||')
echo "=== HEALTH ==="
curl -sS "https://$HOST/healthz" || echo "[!] healthz NG"
echo

echo "=== FILES ==="
for f in data/events/zoom_calls.jsonl data/events/hubspot_appointments.jsonl reports/$(date +%F).md; do
  test -f "$f" && echo "[OK] $f exists" || echo "[..] $f (not yet)"
done
echo

echo "=== PM2 TZ ==="
pm2 env 0 | grep -E '^TZ=' || echo "[..] TZ not visible in pm2 #0"
pm2 env 1 | grep -E '^TZ=' || echo "[..] TZ not visible in pm2 #1"
