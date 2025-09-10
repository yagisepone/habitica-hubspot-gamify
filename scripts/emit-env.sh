#!/usr/bin/env bash
set -euo pipefail

emit () {
  local KEY="$1" FILE="$2"
  # 文法チェック & 最小化
  local MIN
  MIN=$(node -e "const fs=require('fs'); const o=JSON.parse(fs.readFileSync('$FILE','utf8')); process.stdout.write(JSON.stringify(o));")
  # Base64
  local B64
  if command -v base64 >/dev/null 2>&1; then
    B64=$(printf '%s' "$MIN" | base64 -w0 2>/dev/null || printf '%s' "$MIN" | base64)
  else
    B64=$(node -e "console.log(Buffer.from(process.argv[1]).toString('base64'))" "$MIN")
  fi
  # 出力（Renderに貼る用の完成形）
  printf '\n# === %s（どちらか一方を使う） ===\n' "$KEY"
  printf '%s=%s\n'        "$KEY"            "$MIN"
  printf '%s_B64=%s\n'    "$KEY"            "$B64"
}

emit HABITICA_USERS_JSON     secrets/habitica_users.pretty.json
emit NAME_EMAIL_MAP_JSON     secrets/name_email_map.pretty.json
emit HUBSPOT_USER_MAP_JSON   secrets/hubspot_user_map.pretty.json
