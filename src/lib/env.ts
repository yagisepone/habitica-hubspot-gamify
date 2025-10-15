import fs from "fs";

export function readEnvJsonOrFile(jsonVar: string, fileVar: string): string {
  const j = (process.env as any)[jsonVar];
  if (j && String(j).trim()) return String(j).trim();
  const fp = (process.env as any)[fileVar];
  if (fp && String(fp).trim()) {
    try { return fs.readFileSync(String(fp).trim(), "utf8"); } catch {}
  }
  return "";
}

/* ====== ENV 定数 ====== */
export const PORT = Number(process.env.PORT || 10000);
export const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
export const DRY_RUN = String(process.env.DRY_RUN || "0") === "1";
export const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/+$/, "");

/* HubSpot v3 署名 */
export const WEBHOOK_SECRET = process.env.HUBSPOT_WEBHOOK_SIGNING_SECRET || process.env.HUBSPOT_APP_SECRET || "";

/* Zoom 署名/トークン */
export const ZOOM_WEBHOOK_SECRET = String(process.env.ZOOM_WEBHOOK_SECRET || process.env.ZOOM_SECRET || "").trim();
export const ZOOM_VERIFICATION_TOKEN = String(process.env.ZOOM_VERIFICATION_TOKEN || process.env.ZOOM_VTOKEN || "").trim();
export const ZOOM_BEARER_TOKEN = process.env.ZOOM_BEARER_TOKEN || "";
export const ZOOM_SIG_SKEW = Number(process.env.ZOOM_SIG_SKEW || 300);

/* マップの元データ（JSONかファイル） */
export const HUBSPOT_USER_MAP_JSON = readEnvJsonOrFile("HUBSPOT_USER_MAP_JSON", "HUBSPOT_USER_MAP_FILE");
export const HABITICA_USERS_JSON   = readEnvJsonOrFile("HABITICA_USERS_JSON", "HABITICA_USERS_FILE");
export const NAME_EMAIL_MAP_JSON   = readEnvJsonOrFile("NAME_EMAIL_MAP_JSON", "NAME_EMAIL_MAP_FILE");
export const ZOOM_EMAIL_MAP_JSON   = readEnvJsonOrFile("ZOOM_EMAIL_MAP_JSON", "ZOOM_EMAIL_MAP_FILE");

/* 架電XP: +1XP ／ 5分ごと */
export const CALL_TOTALIZE_5MIN = false as const;
export const CALL_XP_PER_CALL = (process.env.CALL_XP_PER_CALL === undefined || process.env.CALL_XP_PER_CALL === "") ? 1 : Number(process.env.CALL_XP_PER_CALL);
export const CALL_XP_PER_5MIN   = Number(process.env.CALL_XP_PER_5MIN || 2);
export const CALL_XP_UNIT_MS    = Number(process.env.CALL_XP_UNIT_MS || 300000);

/* CSV UI：アップロード許可トークン */
export const CSV_UPLOAD_TOKENS = String(process.env.CSV_UPLOAD_TOKENS || "").split(",").map(s => s.trim()).filter(Boolean);

/* 日報ボーナス */
export const DAILY_BONUS_XP = Number(process.env.DAILY_BONUS_XP || 10);
export const DAILY_TASK_MATCH = String(process.env.DAILY_TASK_MATCH || "日報").split(",").map(s => s.trim()).filter(Boolean);
export const HABITICA_WEBHOOK_SECRET = process.env.HABITICA_WEBHOOK_SECRET || AUTH_TOKEN || "";

/* 新規アポXP */
export const APPOINTMENT_XP = Number(process.env.APPOINTMENT_XP || 20);
export const APPOINTMENT_BADGE_LABEL = process.env.APPOINTMENT_BADGE_LABEL || "🎯 新規アポ";
export const APPOINTMENT_VALUES = String(process.env.APPOINTMENT_VALUES || "appointment_scheduled,新規アポ").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

/* CSV：DXPort名必須 */
export const REQUIRE_DXPORT_NAME = true;

/* 売上XP: 10万円→50XP の既定 */
export const SALES_XP_STEP_YEN = Number(process.env.SALES_XP_STEP_YEN || 100000);
export const SALES_XP_PER_STEP = Number(process.env.SALES_XP_PER_STEP || 50);

/* 会社合計：全員付与ON/OFF */
export const COMPANY_SALES_TO_ALL = String(process.env.COMPANY_SALES_TO_ALL || "0") === "1";

/* Habitica レート制御 */
export const HABITICA_MIN_INTERVAL_MS = Number(process.env.HABITICA_MIN_INTERVAL_MS || 300);

/* 重複抑止 TTL（秒） */
export const DEDUPE_TTL_SEC = Number(process.env.DEDUPE_TTL_SEC || 24 * 60 * 60);

/* 安全弁：通話最大3時間 */
export const MAX_CALL_MS = 3 * 60 * 60 * 1000;

/* ショップ／バッジ設定 */
export const SHOP_ALLOW_PAID = String(process.env.SHOP_ALLOW_PAID || "false").toLowerCase() === "true";
export const AUTO_PARTY_DOMAINS = (process.env.AUTO_PARTY_DOMAINS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
export const BADGE_CHECK_ON_EVENTS = String(process.env.BADGE_CHECK_ON_EVENTS || "true").toLowerCase() !== "false";
