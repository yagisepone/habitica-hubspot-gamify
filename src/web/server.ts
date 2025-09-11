// server.ts
import express, { Request, Response } from "express";
import crypto from "crypto";
import Busboy from "busboy";
import { parse as csvParse } from "csv-parse/sync";
import fs from "fs";
import path from "path";

// === habitica-hubspot-gamify : Web server (Render 用) =======================
//
// Endpoints
// - GET  /healthz
// - GET  /support
// - GET  /oauth/callback
// - POST /webhooks/hubspot     // HubSpot Webhook v3（署名検証あり）
// - POST /webhooks/workflow    // HubSpot ワークフローWebhooks（Bearer検証）
// - POST /webhooks/zoom        // Zoom/汎用（Challenge + 署名検証: ts+base64/HEX/両方式 + 任意Bearer）
// - POST /admin/csv            // CSV取り込み（Bearer必須; text/csv or multipart, mode=insert|upsert）
// - GET  /admin/template.csv   // CSVテンプレDL
// - GET  /admin/upload         // 手動アップロードUI
// - GET  /admin/files          // CSVカタログ一覧（Bearer）
// - POST /admin/import-url     // URLのCSVを取り込み（Bearer）
// - GET  /admin/dashboard      // KPI簡易ダッシュボード（今日/昨日）
// - POST /admin/award/maker    // メーカー賞 実行（Bearer）
// - GET  /debug/last           // requires Bearer
// - GET  /debug/recent         // requires Bearer
// - GET  /debug/secret-hint    // requires Bearer
//
const app = express();
app.set("x-powered-by", false);
app.set("trust proxy", true);

// raw body を保存（HubSpot v3 署名/Zoom署名で必須）
app.use(
  express.json({
    verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
      (req as any).rawBody = Buffer.from(buf);
    },
  })
);

// === CORS（/admin 配下だけ許可） ===
app.use((req, res, next) => {
  if (req.path.startsWith("/admin/")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
  }
  next();
});

// ---- 小ユーティリティ（環境変数＝JSON 文字列 or ファイルパスの両対応） ----
function readEnvJsonOrFile(jsonVar: string, fileVar: string, label: string): string {
  const j = (process.env as any)[jsonVar];
  if (j && String(j).trim().length > 0) return String(j).trim();
  const fp = (process.env as any)[fileVar];
  if (fp && String(fp).trim()) {
    try {
      const text = fs.readFileSync(String(fp).trim(), "utf8");
      return text;
    } catch (e: any) {
      console.error(`[env] fail to read ${label} file from ${fp}:`, e?.message || e);
    }
  }
  return "";
}
function safeParse<T = any>(s?: string): T | undefined {
  try {
    return s ? (JSON.parse(s) as T) : undefined;
  } catch {
    return undefined;
  }
}

// ---- Env -------------------------------------------------------------------
const PORT = Number(process.env.PORT || 10000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const DRY_RUN = String(process.env.DRY_RUN || "1") === "1";

// CSVアップロードを許可する追加トークン（カンマ区切り）
const CSV_UPLOAD_TOKENS = String(process.env.CSV_UPLOAD_TOKENS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const WEBHOOK_SECRET =
  process.env.HUBSPOT_WEBHOOK_SIGNING_SECRET ||
  process.env.HUBSPOT_APP_SECRET ||
  process.env.HUBSPOT_CLIENT_SECRET ||
  "";

// Zoom Webhook 用（署名＆チャレンジ用 Secret）
// ※ ZOOM_WEBHOOK_SECRET が無ければ ZOOM_SECRET → SECRET をフォールバックで拾う
// ★ 空白や改行混入を避けるため trim() する（Renderのコピペ事故対策）
const ZOOM_WEBHOOK_SECRET =
  (process.env.ZOOM_WEBHOOK_SECRET || process.env.ZOOM_SECRET || process.env.SECRET || "").trim();
// 追加：Verification Token（Zoomが一部イベントでHEXのみ署名に用いる鍵）
const ZOOM_VERIFICATION_TOKEN =
  (process.env.ZOOM_VERIFICATION_TOKEN || process.env.ZOOM_VTOKEN || "").trim();
// 任意：Bearer フォールバック用（Zoom 側で Authorization を付けられない場合は未使用でOK）
const ZOOM_BEARER_TOKEN = process.env.ZOOM_BEARER_TOKEN || "";
// 許容スキュー（秒）※互換: ZOOM_SKEW_SEC も読む
const ZOOM_SIG_SKEW = Number(process.env.ZOOM_SIG_SKEW || process.env.ZOOM_SKEW_SEC || 300);

const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID || "";
const HUBSPOT_APP_SECRET =
  process.env.HUBSPOT_APP_SECRET || process.env.HUBSPOT_CLIENT_SECRET || "";
const HUBSPOT_REDIRECT_URI =
  process.env.HUBSPOT_REDIRECT_URI || "https://sales-gamify.onrender.com/oauth/callback";

// 公開URL（例: https://sales-gamify.onrender.com）
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/+$/, "");

// “新規アポ”とみなす outcome 値
const APPOINTMENT_VALUES = (process.env.APPOINTMENT_VALUES || "APPOINTMENT_SCHEDULED,新規アポ")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const APPOINTMENT_SET_LOWER = new Set(APPOINTMENT_VALUES.map((v) => v.toLowerCase()));

// 重複抑止TTL（秒）
const DEDUPE_TTL_SEC = Number(process.env.DEDUPE_TTL_SEC || 24 * 60 * 60);

// === ENV: JSON 文字列 / 秘密ファイルの両対応 =====================
// HubSpot userId -> {name,email}
const HUBSPOT_USER_MAP_JSON = readEnvJsonOrFile(
  "HUBSPOT_USER_MAP_JSON",
  "HUBSPOT_USER_MAP_FILE",
  "hubspot_user_map"
);
// メール -> Habitica資格（{email:{userId,apiToken}}）
const HABITICA_USERS_JSON = readEnvJsonOrFile(
  "HABITICA_USERS_JSON",
  "HABITICA_USERS_FILE",
  "habitica_users"
);
// 氏名 -> メール
const NAME_EMAIL_MAP_JSON = readEnvJsonOrFile(
  "NAME_EMAIL_MAP_JSON",
  "NAME_EMAIL_MAP_FILE",
  "name_email_map"
);

// CSVカタログ（任意）
const CSV_CATALOG_JSON = process.env.CSV_CATALOG_JSON || "[]";
const CSV_ALLOWLIST_HOSTS = String(process.env.CSV_ALLOWLIST_HOSTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// 通話KPI 係数
const CALL_XP_PER_CALL = Number(process.env.CALL_XP_PER_CALL || 1);
const CALL_XP_PER_5MIN = Number(process.env.CALL_XP_PER_5MIN || 2);
const CALL_XP_UNIT_MS = Number(process.env.CALL_XP_UNIT_MS || 5 * 60 * 1000);
const CALL_CHATWORK_NOTIFY = String(process.env.CALL_CHATWORK_NOTIFY || "0") === "1";

// Issue#9 フラグ
const CW_NOTIFY_APPROVAL_PER_ROW = String(process.env.CW_NOTIFY_APPROVAL_PER_ROW || "0") === "1";
const CW_NOTIFY_SALES_PER_ROW = String(process.env.CW_NOTIFY_SALES_PER_ROW || "0") === "1";
const MAKER_AWARD_ON_IMPORT = String(process.env.MAKER_AWARD_ON_IMPORT || "0") === "1";

// ---- External connectors ----------------------------------------------------
import { sendChatworkMessage } from "../connectors/chatwork.js";
import {
  createTodo,
  completeTask,
  addApproval,
  addSales,
  addMakerAward,
} from "../connectors/habitica.js";

// ---- Util ------------------------------------------------------------------
function log(...args: any[]) {
  console.log("[web]", ...args);
}
function requireBearer(req: Request, res: Response): boolean {
  const auth = req.header("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!AUTH_TOKEN) {
    res.status(500).json({ ok: false, error: "Server missing AUTH_TOKEN" });
    return false;
  }
  if (token !== AUTH_TOKEN) {
    res.status(401).json({ ok: false, error: "Authentication required" });
    return false;
  }
  return true;
}
function requireBearerCsv(req: Request, res: Response): boolean {
  const auth = req.header("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!AUTH_TOKEN && CSV_UPLOAD_TOKENS.length === 0) {
    res.status(500).json({ ok: false, error: "Server missing tokens" });
    return false;
  }
  if (token === AUTH_TOKEN) return true;
  if (CSV_UPLOAD_TOKENS.includes(token)) return true;
  res.status(401).json({ ok: false, error: "Authentication required" });
  return false;
}
function timingEqual(a: string, b: string) {
  const A = Buffer.from(a),
    B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function addVariants(set: Set<string>, u: string) {
  const add = (s: string) => {
    if (!s) return;
    set.add(s);
    set.add(s.endsWith("/") ? s.slice(0, -1) : s + "/");
    try {
      const d = decodeURI(s);
      set.add(d);
      set.add(d.endsWith("/") ? d.slice(0, -1) : d + "/");
    } catch {}
  };
  add(u);
}
function fmtJST(ms?: number | string) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "-";
  return new Date(n).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function num(v: any) {
  if (v == null || v === "") return undefined;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}
function pickKey(obj: any, matcher: (k: string) => boolean) {
  if (!obj) return undefined;
  for (const k of Object.keys(obj)) {
    if (matcher(k)) return k;
  }
  return undefined;
}
function normSpace(s?: string) {
  return (s || "").replace(/\u3000/g, " ").trim();
}

// ---- JSONL logger ----------------------------------------------------------
function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}
function appendJsonl(fp: string, obj: any) {
  ensureDir(path.dirname(fp));
  fs.appendFileSync(fp, JSON.stringify(obj) + "\n", "utf8");
}
function readJsonlAll(fp: string): any[] {
  try {
    const t = fs.readFileSync(fp, "utf8");
    return t
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s));
  } catch {
    return [];
  }
}
function writeJsonlAll(fp: string, arr: any[]) {
  ensureDir(path.dirname(fp));
  const text =
    arr.map((o) => JSON.stringify(o)).join("\n") + (arr.length ? "\n" : "");
  fs.writeFileSync(fp, text, "utf8");
}
function upsertJsonlByIdBulk(fp: string, items: any[]) {
  if (items.length === 0) return { created: 0, updated: 0 };
  const current = readJsonlAll(fp);
  const map = new Map<string, any>();
  for (const o of current) if (o && o.id != null) map.set(String(o.id), o);
  let created = 0,
    updated = 0;
  for (const it of items) {
    const key = String(it.id);
    if (map.has(key)) updated++;
    else created++;
    map.set(key, it);
  }
  writeJsonlAll(fp, Array.from(map.values()));
  return { created, updated };
}
function isoDay(d?: any) {
  const t = d ? new Date(d) : new Date();
  const tz = "Asia/Tokyo";
  const y = t.toLocaleString("ja-JP", { timeZone: tz, year: "numeric" });
  const m = t.toLocaleString("ja-JP", { timeZone: tz, month: "2-digit" });
  const da = t.toLocaleString("ja-JP", { timeZone: tz, day: "2-digit" });
  return `${y}-${m}-${da}`;
}

// ---- Debug store -----------------------------------------------------------
interface LastEvent {
  at?: string;
  path?: string;
  verified?: boolean;
  note?: string;
  headers?: Record<string, string | undefined>;
  body?: any;
  sig_debug?: any;
  why?: string;
  skew_sec?: number;
}
const lastEvent: LastEvent = {};
const recent: LastEvent[] = [];
function pushRecent(ev: LastEvent) {
  recent.unshift(JSON.parse(JSON.stringify(ev)));
  if (recent.length > 20) recent.pop();
}

// ---- Dedupe ---------------------------------------------------------------
const seen = new Map<string, number>();
function hasSeen(id?: string | number | null) {
  if (!id && id !== 0) return false;
  const key = String(id);
  const now = Date.now();
  for (const [k, ts] of seen) {
    if (now - ts > DEDUPE_TTL_SEC * 1000) seen.delete(k);
  }
  return seen.has(key);
}
function markSeen(id?: string | number | null) {
  if (!id && id !== 0) return;
  seen.set(String(id), Date.now());
}

// ---- Health / Support ------------------------------------------------------
app.get("/healthz", (_req, res) => {
  const habMap = buildHabiticaMap(HABITICA_USERS_JSON);
  const nameMap = buildNameEmailMap(NAME_EMAIL_MAP_JSON);
  res.json({
    ok: true,
    version: "2025-09-11-zoom-hex-vtoken+secret-ready",
    tz: process.env.TZ || "Asia/Tokyo",
    now: new Date().toISOString(),
    hasSecret: !!WEBHOOK_SECRET,
    baseUrl: PUBLIC_BASE_URL || null,
    dryRun: DRY_RUN,
    appointmentValues: APPOINTMENT_VALUES,
    habiticaUserCount: Object.keys(habMap).length,
    nameMapCount: Object.keys(nameMap).length,
  });
});
app.get("/support", (_req, res) =>
  res.type("text/plain").send("Support page (placeholder).")
);

// ---- OAuth callback --------------------------------------------------------
app.get("/oauth/callback", async (req, res) => {
  const code = String(req.query.code || "");
  if (!code) return res.status(400).type("text/plain").send("missing code");
  if (!HUBSPOT_CLIENT_ID || !HUBSPOT_APP_SECRET) {
    return res
      .status(500)
      .type("text/plain")
      .send("server missing HUBSPOT_CLIENT_ID/HUBSPOT_APP_SECRET");
  }
  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: HUBSPOT_CLIENT_ID,
      client_secret: HUBSPOT_APP_SECRET,
      redirect_uri: HUBSPOT_REDIRECT_URI,
      code,
    });
    const r = await fetch("https://api.hubapi.com/oauth/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    } as any);
    const json = await r.json();
    if (!(r as any).ok) {
      console.error("[oauth] exchange failed:", json);
      return res.status(502).type("text/plain").send("token exchange failed");
    }
    res
      .type("text/plain")
      .send("Connected! You can close this window. (OAuth token issued)");
  } catch (e) {
    console.error(e);
    res.status(500).type("text/plain").send("token exchange error");
  }
});

// ============================================================================
// HubSpot Webhook v3（署名検証）
// ============================================================================
app.post(
  "/webhooks/hubspot",
  async (req: Request & { rawBody?: Buffer }, res: Response) => {
    const method = (req.method || "POST").toUpperCase();
    const withQuery =
      (req as any).originalUrl || (req as any).url || "/webhooks/hubspot";
    const urlObj = new URL(withQuery, "http://dummy.local");
    const pathOnly = urlObj.pathname + (urlObj.search || "");

    const tsHeader = req.header("x-hubspot-request-timestamp") || "";
    const sigHeader = req.header("x-hubspot-signature-v3") || "";
    const verHeader = (
      req.header("x-hubspot-signature-version") || ""
    ).toLowerCase();

    const raw: Buffer =
      (req as any).rawBody ?? Buffer.from(JSON.stringify((req as any).body ?? ""), "utf8");

    const proto =
      String(req.headers["x-forwarded-proto"] || "")
        .split(",")[0]
        .trim() || (req as any).protocol || "https";
    const hostHdr = String(req.headers["x-forwarded-host"] || req.headers["host"] || "")
      .split(",")[0]
      .trim();

    const candidates = new Set<string>();
    addVariants(candidates, withQuery);
    addVariants(candidates, pathOnly);
    if (hostHdr) {
      addVariants(candidates, `${proto}://${hostHdr}${withQuery}`);
      addVariants(candidates, `${proto}://${hostHdr}${pathOnly}`);
    }
    if (PUBLIC_BASE_URL) {
      addVariants(candidates, new URL(withQuery, PUBLIC_BASE_URL).toString());
      addVariants(candidates, new URL(pathOnly, PUBLIC_BASE_URL).toString());
    }

    const calc = Array.from(candidates).map((u) => {
      const base = Buffer.concat([
        Buffer.from(method, "utf8"),
        Buffer.from(u, "utf8"),
        raw,
        Buffer.from(tsHeader, "utf8"),
      ]);
      const h = crypto
        .createHmac("sha256", WEBHOOK_SECRET)
        .update(base)
        .digest("base64");
      return { uri: u, sig: h };
    });

    const hit = calc.find((c) => timingEqual(c.sig, sigHeader));
    const verified = !!hit;
    res.status(204).end();

    // ログ用
    let tsNote: string | undefined;
    const MAX_SKEW_MS = 5 * 60 * 1000;
    const now = Date.now();
    const tsNum = Number(tsHeader);
    if (!Number.isNaN(tsNum) && Math.abs(now - tsNum) > MAX_SKEW_MS)
      tsNote = "stale_timestamp(>5min)";

    let parsed: any = null;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      parsed = null;
    }

    const ev: LastEvent = {
      at: new Date().toISOString(),
      path: withQuery,
      verified,
      note: verified ? "hubspot-event" : "invalid-signature",
      headers: {
        "x-hubspot-signature-version": verHeader || undefined,
        "x-hubspot-signature-v3": sigHeader || undefined,
        "x-hubspot-request-timestamp": tsHeader || undefined,
        "content-type": req.header("content-type") || undefined,
        "user-agent": req.header("user-agent") || undefined,
        host: hostHdr || undefined,
        proto: proto || undefined,
      },
      body: parsed,
      sig_debug: verified
        ? { matchedUri: hit?.uri }
        : {
            reason: "mismatch",
            method,
            withQuery,
            pathOnly,
            proto,
            hostHdr,
            ts: tsHeader,
            ts_note: tsNote,
            sig_first12: sigHeader.slice(0, 12),
            calc_first12: calc.slice(0, 6).map((c) => c.sig.slice(0, 12)),
          },
    };
    Object.assign(lastEvent, ev);
    pushRecent(ev);
    log(`received uri=${withQuery} verified=${verified} note=${ev.note}`);

    // 正規化＆処理
    if (verified && Array.isArray(parsed)) {
      for (const e of parsed) {
        const isCall =
          String(e.subscriptionType || "")
            .toLowerCase()
            .includes("call") ||
          String(e.objectType || "").toLowerCase().includes("call") ||
          String(e.objectTypeId || "") === "0-48";

        // 成果=新規アポ
        if (isCall && e.propertyName === "hs_call_disposition") {
          await handleNormalizedEvent({
            source: "v3",
            eventId: e.eventId ?? e.attemptNumber,
            callId: e.objectId,
            outcome: e.propertyValue,
            occurredAt: e.occurredAt,
            raw: e,
          });
        }
        // 通話時間
        if (isCall && e.propertyName === "hs_call_duration") {
          const ms = inferDurationMs(e.propertyValue);
          await handleCallDurationEvent({
            source: "v3",
            eventId: e.eventId ?? e.attemptNumber,
            callId: e.objectId,
            durationMs: ms,
            occurredAt: e.occurredAt,
            raw: e,
          });
        }
      }
    }
  }
);

// ============================================================================
// ワークフロー Webhooks（署名なし・Bearer検証）
// ============================================================================
app.post("/webhooks/workflow", async (req: Request, res: Response) => {
  const tok = (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!AUTH_TOKEN || tok !== AUTH_TOKEN)
    return res.status(401).json({ ok: false, error: "auth" });

  const b = (req as any).body || {};
  const outcome =
    b.outcome ||
    b.hs_call_disposition ||
    b.callOutcome ||
    b.properties?.hs_call_disposition;
  const callId = b.callId || b.engagementId || b.eventId || b.id;
  const occurredAt =
    b.endedAt || b.occurredAt || b.timestamp || (b.properties && b.properties.hs_timestamp);

  const ev: LastEvent = {
    at: new Date().toISOString(),
    path: "/webhooks/workflow",
    verified: true,
    note: "workflow-event",
    headers: {
      "content-type": req.header("content-type") || undefined,
      "user-agent": req.header("user-agent") || undefined,
    },
    body: b,
  };
  Object.assign(lastEvent, ev);
  pushRecent(ev);
  log(
    `received path=/webhooks/workflow verified=true outcome=${outcome} callId=${callId}`
  );

  await handleNormalizedEvent({
    source: "workflow",
    eventId: b.eventId || callId,
    callId,
    outcome,
    occurredAt,
    raw: b,
  });

  if (b.type === "call.duration") {
    const ms = inferDurationMs(b.durationMs ?? b.durationSec);
    await handleCallDurationEvent({
      source: "workflow",
      eventId: b.eventId || callId || `dur:${Date.now()}`,
      callId: callId || b.callId || b.id,
      durationMs: ms,
      occurredAt,
      raw: b,
    });
  }
  return res.json({ ok: true });
});

// ---- Zoom 署名検証（A/B: ts+base64 & C: HEX no-ts） ------------------------
function verifyZoomSignatureDetailed(
  req: Request & { rawBody?: Buffer },
  secret: string,
  verificationToken?: string
): {
  ok: boolean;
  why?: string;
  skew?: number;
  hdr12?: string;
  macA12?: string;
  macB12?: string;
  variant?: string;
  hex1_12?: string;
  hex2_12?: string;
  hex3_12?: string;
  vtoken_hex12?: string;
} {
  if (!secret && !verificationToken) return { ok: false, why: "no_secret" };

  const header = req.get("x-zm-signature") || "";
  if (!header) return { ok: false, why: "no_header" };

  const body = (req.rawBody ?? Buffer.from("", "utf8")).toString("utf8");

  // Variant-C: v0=<HEXのみ>（Zoom Phone が稀に送る / timestamp なし）
  {
    const mHex = header.match(/^v0=([a-f0-9]{64})$/i);
    if (mHex) {
      const sigHex = mHex[1].toLowerCase();
      const sigBuf = Buffer.from(sigHex, "hex");
      const safeEqHex = (hex: string) => {
        try {
          return crypto.timingSafeEqual(sigBuf, Buffer.from(hex, "hex"));
        } catch {
          return false;
        }
      };

      // まず Verification Token 鍵で HMAC(body)
      if (verificationToken) {
        const vtMac = crypto.createHmac("sha256", verificationToken).update(body).digest("hex");
        if (safeEqHex(vtMac)) {
          return {
            ok: true,
            variant: "hex_no_ts_vtoken",
            hdr12: sigHex.slice(0, 12),
            vtoken_hex12: vtMac.slice(0, 12),
          };
        }
      }

      // Secret Token 鍵の既存互換（本実装では body / "v0"+body / "v0:"+body を試す）
      const h1 = crypto.createHmac("sha256", secret).update(body).digest("hex");
      const h2 = crypto.createHmac("sha256", secret).update("v0" + body).digest("hex");
      const h3 = crypto.createHmac("sha256", secret).update("v0:" + body).digest("hex");
      const ok = safeEqHex(h1) || safeEqHex(h2) || safeEqHex(h3);
      return {
        ok,
        why: ok ? undefined : "signature_mismatch_hex",
        hdr12: sigHex.slice(0, 12),
        variant: ok ? (safeEqHex(h1) ? "hex_no_ts_secret" : "hex_no_ts_secret") : "hex_no_ts",
        hex1_12: h1.slice(0, 12),
        hex2_12: h2.slice(0, 12),
        hex3_12: h3.slice(0, 12),
      };
    }
  }

  // Variant-A/B: v0=<ts>:<base64> or v0:<ts>:<base64>（Secret Token 鍵）
  const m = header.match(/^v0[:=](\d+):([A-Za-z0-9+/=]+)$/);
  if (!m) return { ok: false, why: "bad_format" };

  const ts = Number(m[1]);
  const sigB64 = m[2];
  if (!Number.isFinite(ts) || !sigB64) return { ok: false, why: "bad_format" };

  const now = Math.floor(Date.now() / 1000);
  const skew = Math.abs(now - ts);
  if (skew > ZOOM_SIG_SKEW)
    return { ok: false, why: "timestamp_skew_exceeded", skew };

  // 方式A: HMAC(secret, ts + body) -> base64
  const macA = crypto
    .createHmac("sha256", secret)
    .update(String(ts) + body)
    .digest("base64");
  // 方式B: HMAC(secret, `v0:${ts}:${body}`) -> base64
  const macB = crypto
    .createHmac("sha256", secret)
    .update(`v0:${ts}:${body}`)
    .digest("base64");

  const sigBuf = Buffer.from(sigB64);
  const eqB64 = (mac: string) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(mac), sigBuf);
    } catch {
      return false;
    }
  };

  const ok = eqB64(macA) || eqB64(macB);
  return {
    ok,
    why: ok ? undefined : "signature_mismatch",
    skew,
    hdr12: sigB64.slice(0, 12),
    macA12: macA.slice(0, 12),
    macB12: macB.slice(0, 12),
    variant: "v0_ts_b64",
  };
}

// ============================================================================
// Zoom/汎用 コール入口（Zoom Phone想定）
// ============================================================================
app.post(
  "/webhooks/zoom",
  async (req: Request & { rawBody?: Buffer }, res: Response) => {
    const rawText = req.rawBody ? req.rawBody.toString("utf8") : undefined;
    let b: any = (req as any).body || {};
    if (!b || (Object.keys(b).length === 0 && rawText)) {
      try {
        b = JSON.parse(rawText!);
      } catch {}
    }

    // ① URL検証（plainToken）: Zoom の Validate で使用
    const plain =
      b?.plainToken || b?.payload?.plainToken || b?.event?.plainToken || undefined;
    if (plain) {
      const key = ZOOM_WEBHOOK_SECRET || AUTH_TOKEN || "dummy";
      const enc = crypto.createHmac("sha256", key).update(String(plain)).digest("hex");
      return res.json({ plainToken: String(plain), encryptedToken: enc });
    }

    // ② 認証
    let via: "signature" | "bearer" | "none" = "none";
    let authOK = false;
    let why: string | undefined;
    let skew: number | undefined;
    let sigDebug: any = undefined;

    // まず 署名（推奨 / A/B/C すべて対応）
    if (req.get("x-zm-signature") && (ZOOM_WEBHOOK_SECRET || ZOOM_VERIFICATION_TOKEN)) {
      const chk = verifyZoomSignatureDetailed(req, ZOOM_WEBHOOK_SECRET, ZOOM_VERIFICATION_TOKEN);
      authOK = chk.ok;
      why = chk.why;
      skew = chk.skew;
      sigDebug = {
        first12_hdr: chk.hdr12,
        first12_A: chk.macA12,
        first12_B: chk.macB12,
        variant: chk.variant,
        hex1_12: chk.hex1_12,
        hex2_12: chk.hex2_12,
        hex3_12: chk.hex3_12,
        vtoken_hex12: chk.vtoken_hex12,
      };
      if (authOK) via = "signature";
    } else if (req.get("x-zm-signature") && !ZOOM_WEBHOOK_SECRET && !ZOOM_VERIFICATION_TOKEN) {
      why = "server_missing_secret";
    }

    // フォールバック：Bearer（任意）
    if (!authOK) {
      const expected = ZOOM_BEARER_TOKEN || ZOOM_WEBHOOK_SECRET || AUTH_TOKEN || "";
      if (expected) {
        const tok = (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
        if (tok === expected) {
          authOK = true;
          via = "bearer";
          why = undefined;
        } else if (!why) {
          why = "bad_bearer";
        }
      }
    }

    // デバッグ格納（成功・失敗どちらでも）
    const evBase: LastEvent = {
      at: new Date().toISOString(),
      path: "/webhooks/zoom",
      verified: authOK,
      note: "zoom-event",
      headers: {
        "x-zm-signature": req.get("x-zm-signature") || undefined,
        authorization: req.get("authorization") || undefined,
        via,
      },
      body: b,
      sig_debug: sigDebug,
      why,
      skew_sec: skew,
    };
    Object.assign(lastEvent, evBase);
    pushRecent(evBase);

    if (!authOK)
      return res
        .status(401)
        .json({ ok: false, error: "auth", why, skew_sec: skew });

    // ③ 通常イベント処理（通話時間など）
    const raw = b?.payload?.object || b?.object || b || {};
    const email =
      raw.user_email ||
      raw.owner_email ||
      raw.caller_email ||
      raw.callee_email ||
      b.email ||
      undefined;

    const cand = [
      raw.duration_ms,
      raw.call_duration_ms,
      raw.durationMs,
      raw.duration,
      raw.call_duration,
      b.duration,
    ];
    let ms = cand.map(Number).find((x) => Number.isFinite(x)) || 0;
    if (ms > 0 && ms < 100000) ms = ms * 1000;
    if (ms <= 0 && raw.start_time && raw.end_time) {
      const st = new Date(raw.start_time).getTime();
      const et = new Date(raw.end_time).getTime();
      if (Number.isFinite(st) && Number.isFinite(et)) ms = Math.max(0, et - st);
    }

    const callId =
      raw.call_id ||
      raw.session_id ||
      raw.callID ||
      raw.sessionID ||
      b.id ||
      `zoom:${Date.now()}`;
    const whoRaw = { userEmail: email };

    log(
      `[zoom] event=${b?.event || b?.event_type || "(unknown)"} accepted via=${via} callId=${callId} ms=${ms}`
    );

    await handleCallDurationEvent({
      source: "workflow", // 集計系に合わせて workflow を再利用
      eventId: b.event_id || b.eventId || callId,
      callId,
      durationMs: inferDurationMs(ms),
      occurredAt: b.timestamp || raw.end_time || Date.now(),
      raw: whoRaw,
    });

    return res.json({ ok: true, accepted: true, ms, via });
  }
);

// ====================== /admin/csv ==========================================
const _csvSeen = new Map<string, number>();
const _CSV_TTL = 7 * 24 * 60 * 60 * 1000;
function _csvDedupeKey(r: any) {
  const s = `${r.type}|${r.email || ""}|${r.amount || 0}|${r.maker || ""}|${
    r.date || ""
  }|${r.id}`;
  return crypto.createHash("sha256").update(s).digest("hex");
}
function _csvMarkOrSkip(key: string) {
  const now = Date.now();
  for (const [k, ts] of [..._csvSeen.entries()]) if (now - ts > _CSV_TTL) _csvSeen.delete(k);
  if (_csvSeen.has(key)) return false;
  _csvSeen.set(key, now);
  return true;
}

app.post("/admin/csv", express.text({ type: "text/csv", limit: "10mb" }));
app.post("/admin/csv", async (req: Request, res: Response) => {
  if (!requireBearerCsv(req, res)) return;
  const ct = String(req.headers["content-type"] || "");
  try {
    if (/^text\/csv/i.test(ct))
      return await _handleCsvText(String((req as any).body || ""), req, res);
    if (/multipart\/form-data/i.test(ct)) return await _handleCsvMultipart(req, res);
    return res.status(415).json({ ok: false, error: "unsupported content-type" });
  } catch (e: any) {
    console.error("[/admin/csv]", e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

async function _handleCsvMultipart(req: Request, res: Response) {
  let csvText = "";
  await new Promise<void>((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    bb.on("file", (_name, file, info) => {
      const mt = String(info.mimeType || "").toLowerCase();
      const ok =
        mt.includes("csv") ||
        mt === "text/plain" ||
        mt === "application/octet-stream" ||
        mt.endsWith("ms-excel");
      if (!ok) return reject(new Error(`file must be CSV (got ${info.mimeType})`));
      file.setEncoding("utf8");
      file.on("data", (d: string) => (csvText += d));
    });
    bb.on("error", reject);
    bb.on("finish", resolve);
    (req as any).pipe(bb);
  });
  return _handleCsvText(csvText, req, res);
}

type CsvNorm = {
  type: "approval" | "sales" | "maker";
  email?: string;
  actorName?: string;
  amount?: number;
  maker?: string;
  id: string;
  date?: string;
  notes?: string;
};

// ENV: 氏名→メール
function buildNameEmailMap(jsonStr: string): Record<string, string> {
  const parsed = safeParse<Record<string, string>>(jsonStr) || {};
  const out: Record<string, string> = {};
  for (const [name, email] of Object.entries(parsed)) {
    const n = normSpace(String(name || ""));
    if (!n) continue;
    if (!email) continue;
    out[n] = String(email).trim().toLowerCase();
  }
  return out;
}
const NAME2MAIL = buildNameEmailMap(NAME_EMAIL_MAP_JSON);

// ENV: メール→Habitica資格
type HabiticaCred = { userId: string; apiToken: string };
function buildHabiticaMap(jsonStr: string): Record<string, HabiticaCred> {
  const parsed = safeParse<Record<string, HabiticaCred>>(jsonStr) || {};
  const out: Record<string, HabiticaCred> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!v || !(v as any).userId || !(v as any).apiToken) continue;
    out[String(k).toLowerCase()] = {
      userId: String((v as any).userId),
      apiToken: String((v as any).apiToken),
    };
  }
  return out;
}
const HAB_MAP = buildHabiticaMap(HABITICA_USERS_JSON);
function getHabiticaCredFor(email?: string): HabiticaCred | undefined {
  if (!email) return undefined;
  return HAB_MAP[email.toLowerCase()];
}

// 「DX PORTの 〇〇」から氏名を抽出
function extractDxPortNameFromText(s?: string): string | undefined {
  if (!s) return undefined;
  const text = String(s);
  const m = text.match(
    /DX\s*PORT(?:の|:)?\s*([^\n\r、，。・;；【】\[\]\(\)]+?)(?:\s*(?:さん|様|殿|君))?(?:$|[。．、，\s])/i
  );
  if (m && m[1]) {
    const name = normSpace(m[1]).replace(/\s+/g, " ").trim();
    if (name) return name;
  }
  return undefined;
}

// CSV 正規化
function normalizeCsvRows(records: any[]): CsvNorm[] {
  const out: CsvNorm[] = [];
  for (const r of records) {
    // 1) 仕様書CSV
    const typeRaw = String((r.type ?? r.Type ?? "")).trim();
    if (typeRaw) {
      const t =
        (typeRaw === "承認"
          ? "approval"
          : typeRaw === "売上"
          ? "sales"
          : typeRaw === "メーカー"
          ? "maker"
          : typeRaw) as any;
      if (!["approval", "sales", "maker"].includes(t)) continue;
      const email = r.email ? String(r.email).trim().toLowerCase() : undefined;
      const amountVal = r.amount != null ? num(r.amount) : undefined;
      const maker = r.maker ? String(r.maker).trim() : undefined;
      let id = String(r.id || "").trim();
      const date = r.date ? String(r.date) : undefined;
      const notes = r.notes ? String(r.notes) : undefined;
      if (!id) id = `${t}:${email || "-"}:${amountVal || 0}:${maker || "-"}:${date || "-"}`;
      out.push({ type: t, email, amount: amountVal, maker, id, date, notes });
      continue;
    }

    // 2) 日本語アポイントCSV（自動判別）
    const hasJP =
      r["承認日時"] != null ||
      r["商談ステータス"] != null ||
      r["報酬"] != null ||
      r["追加報酬"] != null ||
      pickKey(r, (k) => /(承認条件|設問|質問).*(回答)?\s*23/.test(k)) != null;
    if (!hasJP) continue;

    // 2-a) アクター氏名
    let actorName: string | undefined;
    const q23Key = pickKey(r, (k) => /(承認条件|設問|質問).*(回答)?\s*23/.test(k));
    if (q23Key) actorName = extractDxPortNameFromText(String(r[q23Key] ?? ""));
    if (!actorName) {
      for (const v of Object.values(r)) {
        actorName = extractDxPortNameFromText(String(v ?? ""));
        if (actorName) break;
      }
    }

    // 2-b) メールは「氏名→メール」マップのみ使用
    const emailFromName = actorName ? NAME2MAIL[actorName] : undefined;
    const email = emailFromName;

    // 2-c) ステータス・金額・メーカー
    const status = normSpace(String(r["商談ステータス"] || ""));
    const approvedAt =
      String(r["承認日時"] || r["商談終了日時"] || r["商談開始日時"] || "") || undefined;
    const makerName = r["メーカー名"] ? String(r["メーカー名"]).trim() : undefined;
    const reward = num(r["報酬"]) || 0;
    const rewardExtra = num(r["追加報酬"]) || 0;
    const salesAmt = (reward || 0) + (rewardExtra || 0);

    // 2-d) 安定ID
    const baseIdRaw = String(r["ID"] || r["id"] || r["案件ID"] || r["レコードID"] || "").trim();
    const baseId =
      baseIdRaw ||
      [actorName || email || "-", approvedAt || status || "-", salesAmt || 0, makerName || "-"].join(
        "|"
      );

    // 承認
    const isApproved = /承認/.test(status) || !!approvedAt;
    if (isApproved) {
      out.push({
        type: "approval",
        email,
        actorName,
        id: `${baseId}`,
        date: approvedAt,
        maker: makerName,
        notes: makerName ? `メーカー=${makerName}` : undefined,
      });
    }
    // 売上
    if (salesAmt > 0) {
      out.push({
        type: "sales",
        email,
        actorName,
        amount: salesAmt,
        id: `${baseId}:sales`,
        date: approvedAt,
        maker: makerName,
        notes: makerName ? `メーカー=${makerName}` : undefined,
      });
    }
    // maker 自動は必要時のみ
  }
  return out;
}

// ============ Chatwork 行単位通知用 ==================
function cwName(actorName?: string, email?: string) {
  return actorName || (email ? String(email).split("@")[0] : "担当者");
}
function makeApprovalMessage(r: CsvNorm) {
  const day = isoDay(r.date);
  return [
    "[info]",
    "[title]🟦 承認 成立[/title]",
    `担当 : ${cwName(r.actorName, r.email)}`,
    r.maker ? `メーカー : ${r.maker}` : undefined,
    `承認日 : ${day}`,
    r.notes ? `備考 : ${r.notes}` : undefined,
    "[/info]",
  ]
    .filter(Boolean)
    .join("\n");
}
function makeSalesMessage(r: CsvNorm, amt: number) {
  const day = isoDay(r.date);
  return [
    "[info]",
    "[title]💰 売上 登録[/title]",
    `担当 : ${cwName(r.actorName, r.email)}`,
    `金額 : ¥${amt.toLocaleString()}`,
    r.maker ? `メーカー : ${r.maker}` : undefined,
    `日付 : ${day}`,
    r.notes ? `備考 : ${r.notes}` : undefined,
    "[/info]",
  ]
    .filter(Boolean)
    .join("\n");
}

async function _handleCsvText(csvText: string, req: Request, res: Response) {
  const modeRaw = String((req as any).query?.mode || "").toLowerCase();
  const MODE: "insert" | "upsert" =
    modeRaw === "insert" || modeRaw === "upsert" ? (modeRaw as any) : "upsert";
  const useDedupe = MODE === "insert";

  const records: any[] = csvParse(csvText, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
  const rows = normalizeCsvRows(records);

  let received = rows.length,
    dup = 0,
    err = 0;
  let nApproval = 0,
    nSales = 0,
    nMaker = 0,
    sumSales = 0;
  const errors: any[] = [];
  const _cwQueue: string[] = [];
  const bufApprovals: any[] = [];
  const bufSales: any[] = [];
  const bufMakers: any[] = [];
  const affectedDays = new Set<string>();

  for (const r of rows) {
    try {
      if (useDedupe) {
        const key = _csvDedupeKey(r);
        if (!_csvMarkOrSkip(key)) {
          dup++;
          continue;
        }
      }
      const cred = getHabiticaCredFor(r.email);
      if (r.type === "approval") {
        nApproval++;
        const day = isoDay(r.date);
        affectedDays.add(day);
        const obj = {
          at: new Date().toISOString(),
          day,
          email: r.email || null,
          actor: r.actorName ? { name: r.actorName, email: r.email || null } : undefined,
          id: r.id,
          maker: r.maker || undefined,
          notes: r.notes,
        };
        bufApprovals.push(obj);
        if (!DRY_RUN && cred && MODE === "insert")
          await addApproval(cred, 1, r.notes || "CSV取り込み");
        if (!DRY_RUN && MODE === "insert" && CW_NOTIFY_APPROVAL_PER_ROW)
          _cwQueue.push(makeApprovalMessage(r));
      } else if (r.type === "sales") {
        nSales++;
        const amt = Number(r.amount || 0);
        sumSales += amt;
        const day = isoDay(r.date);
        affectedDays.add(day);
        const obj = {
          at: new Date().toISOString(),
          day,
          email: r.email || null,
          actor: r.actorName ? { name: r.actorName, email: r.email || null } : undefined,
          amount: amt,
          id: r.id,
          maker: r.maker || undefined,
          notes: r.notes,
        };
        bufSales.push(obj);
        if (!DRY_RUN && cred && MODE === "insert")
          await addSales(cred, amt, r.notes || "CSV取り込み");
        if (!DRY_RUN && MODE === "insert" && CW_NOTIFY_SALES_PER_ROW)
          _cwQueue.push(makeSalesMessage(r, amt));
      } else if (r.type === "maker") {
        nMaker++;
        const day = isoDay(r.date);
        affectedDays.add(day);
        const obj = {
          at: new Date().toISOString(),
          day,
          email: r.email || null,
          actor: r.actorName ? { name: r.actorName, email: r.email || null } : undefined,
          maker: r.maker,
          id: r.id,
        };
        bufMakers.push(obj);
        if (!DRY_RUN && cred && MODE === "insert") await addMakerAward(cred, 1);
      }
    } catch (e: any) {
      err++;
      errors.push({ id: r.id, error: e?.message || String(e) });
    }
  }

  if (MODE === "insert") {
    for (const o of bufApprovals) appendJsonl("data/events/approvals.jsonl", o);
    for (const o of bufSales) appendJsonl("data/events/sales.jsonl", o);
    for (const o of bufMakers) appendJsonl("data/events/maker.jsonl", o);
  } else {
    upsertJsonlByIdBulk("data/events/approvals.jsonl", bufApprovals);
    upsertJsonlByIdBulk("data/events/sales.jsonl", bufSales);
    upsertJsonlByIdBulk("data/events/maker.jsonl", bufMakers);
  }

  if (!DRY_RUN && _cwQueue.length > 0) {
    try {
      for (const m of _cwQueue) await sendChatworkMessage(m);
    } catch {}
  }

  const summary = `🧾 CSV取込(${MODE}): 承認${nApproval} / 売上${nSales}(計${sumSales.toLocaleString()}) / メーカー${nMaker} [重複${dup}, 失敗${err}]`;
  try {
    await sendChatworkMessage(summary);
  } catch {}

  if (MAKER_AWARD_ON_IMPORT && MODE === "insert" && affectedDays.size > 0) {
    try {
      for (const d of affectedDays) {
        await runMakerAward(d, true);
      }
    } catch (e) {
      console.error(
        "[maker-award] on-import error",
        (e as any)?.message || e
      );
    }
  }

  return res.json({
    ok: true,
    mode: MODE,
    received,
    accepted: { approval: nApproval, sales: nSales, maker: nMaker },
    totalSales: sumSales,
    duplicates: dup,
    errors: err,
    error_rows: errors,
  });
}

// ---- 正規化イベントの共通ハンドラ -----------------------------------------
type Normalized = {
  source: "v3" | "workflow";
  eventId?: any;
  callId?: any;
  outcome?: string;
  occurredAt?: any;
  raw?: any;
};

async function handleNormalizedEvent(ev: Normalized) {
  const idForDedupe = ev.eventId ?? ev.callId;
  if (hasSeen(idForDedupe)) {
    log(`skip duplicate id=${idForDedupe}`);
    return;
  }
  markSeen(idForDedupe);

  const outcomeStr = String(ev.outcome ?? "").trim();
  const isAppointment =
    outcomeStr && APPOINTMENT_SET_LOWER.has(outcomeStr.toLowerCase());
  if (isAppointment) {
    await awardXpForAppointment(ev);
    await notifyChatworkAppointment(ev);
  } else {
    log(`non-appointment outcome=${outcomeStr || "(empty)"} source=${ev.source}`);
  }
}

// ---- だれが獲得したかを解決 ------------------------------------------------
function extractUserIdFromRaw(raw: any): string | undefined {
  const m = String(raw?.sourceId || "").match(/userId:(\d+)/);
  return m ? m[1] : undefined;
}
function resolveActor(ev: {
  source: "v3" | "workflow";
  raw?: any;
}): { name: string; email?: string } {
  const raw = ev.raw || {};
  const email =
    raw.actorEmail ||
    raw.ownerEmail ||
    raw.userEmail ||
    raw?.owner?.email ||
    raw?.properties?.hs_created_by_user_id?.email ||
    raw?.userEmail;
  const userId = extractUserIdFromRaw(raw) || raw.userId || raw.actorId;
  const map = safeParse<Record<string, { name?: string; email?: string }>>(
    HUBSPOT_USER_MAP_JSON
  );
  const mapped = userId && map ? map[String(userId)] : undefined;
  const display =
    (mapped && mapped.name) ||
    (email ? String(email).split("@")[0] : undefined) ||
    "担当者";
  const finalEmail = email || (mapped && mapped.email) || undefined;
  return { name: display, email: finalEmail };
}

// ---- Habitica: アポ演出 ----------------------------------------------------
async function awardXpForAppointment(ev: Normalized) {
  const when = fmtJST(ev.occurredAt);
  const who = resolveActor({ source: ev.source, raw: ev.raw });
  const cred = getHabiticaCredFor(who.email);
  const msg = `[XP] appointment scheduled (source=${ev.source}) callId=${ev.callId} at=${when} by=${who.name}`;
  if (DRY_RUN || !cred) {
    log(`${msg} (DRY_RUN or no-cred)`);
    appendJsonl("data/events/appointments.jsonl", {
      at: new Date().toISOString(),
      day: isoDay(ev.occurredAt),
      callId: ev.callId,
      actor: who,
    });
    return;
  }
  try {
    const todo = await createTodo(
      `🟩 新規アポ（${who.name}）`,
      `HubSpot：成果=新規アポ\nsource=${ev.source}\ncallId=${ev.callId}`,
      undefined,
      cred
    );
    const id = (todo as any)?.id;
    if (id) await completeTask(id, cred);
    log(msg);
    appendJsonl("data/events/appointments.jsonl", {
      at: new Date().toISOString(),
      day: isoDay(ev.occurredAt),
      callId: ev.callId,
      actor: who,
    });
  } catch (e: any) {
    console.error("[habitica] failed:", e?.message || e);
  }
}

// ---- 通話KPI：duration -----------------------------------------------------
type CallDurEv = {
  source: "v3" | "workflow";
  eventId?: any;
  callId?: any;
  durationMs: number;
  occurredAt?: any;
  raw?: any;
};
function inferDurationMs(v: any) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 100000 ? Math.floor(n) : Math.floor(n * 1000);
}
function computeCallXp(ms: number) {
  const base = CALL_XP_PER_CALL;
  const extra = ms > 0 ? Math.floor(ms / CALL_XP_UNIT_MS) * CALL_XP_PER_5MIN : 0;
  return base + extra;
}
async function awardXpForCallDuration(ev: CallDurEv) {
  const when = fmtJST(ev.occurredAt);
  const who = resolveActor({ source: ev.source, raw: ev.raw });
  const cred = getHabiticaCredFor(who.email);
  const xp = computeCallXp(ev.durationMs);
  if (xp <= 0) {
    log(`[call] duration=0 skip callId=${ev.callId}`);
    return;
  }
  const minutes = (ev.durationMs / 60000).toFixed(1);
  const title = `📞 架電(${who.name}) +${xp}XP`;
  const notes = `HubSpot通話
source=${ev.source}
callId=${ev.callId}
duration=${minutes}min
calc=+${CALL_XP_PER_CALL} (1call) + ${CALL_XP_PER_5MIN}×floor(${ev.durationMs}/${CALL_XP_UNIT_MS})`;
  if (DRY_RUN || !cred) {
    log(`[call] (DRY_RUN or no-cred) ${title} @${when}`);
    appendJsonl("data/events/calls.jsonl", {
      at: new Date().toISOString(),
      day: isoDay(ev.occurredAt),
      callId: ev.callId,
      ms: ev.durationMs,
      xp: computeCallXp(ev.durationMs),
      actor: who,
    });
    return;
  }
  try {
    const todo = await createTodo(title, notes, undefined, cred);
    const id = (todo as any)?.id;
    if (id) await completeTask(id, cred);
    log(`[call] xp=${xp} ms=${ev.durationMs} by=${who.name} at=${when}`);
    appendJsonl("data/events/calls.jsonl", {
      at: new Date().toISOString(),
      day: isoDay(ev.occurredAt),
      callId: ev.callId,
      ms: ev.durationMs,
      xp: computeCallXp(ev.durationMs),
      actor: who,
    });
    if (CALL_CHATWORK_NOTIFY) {
      const msg = [
        "[info]",
        "[title]📞 架電XP 付与[/title]",
        `${who.name} さんに +${xp}XP を付与しました。`,
        `[hr]• 通話ID: ${ev.callId}\n• 通話時間: ${minutes}分`,
        "[/info]",
      ].join("\n");
      try {
        await sendChatworkMessage(msg);
      } catch {}
    }
  } catch (e: any) {
    console.error("[call] habitica failed:", e?.message || e);
  }
}
async function handleCallDurationEvent(ev: CallDurEv) {
  const idForDedupe = ev.eventId ?? ev.callId ?? `dur:${ev.durationMs}`;
  if (hasSeen(idForDedupe)) {
    log(`skip duplicate call-dur id=${idForDedupe}`);
    return;
  }
  markSeen(idForDedupe);
  await awardXpForCallDuration(ev);
}

// ---- Chatwork: “誰がアポ獲得したか”演出 -----------------------------------
function formatChatworkMessage(ev: Normalized) {
  const when = fmtJST(ev.occurredAt);
  const cid = ev.callId ?? "-";
  const who = resolveActor({ source: ev.source, raw: ev.raw });
  return [
    "[info]",
    "[title]皆さんお疲れ様です！[/title]",
    `${who.name}さんが【新規アポ】を獲得しました🎉🎉`,
    "ナイスコール！🌟 この調子であともう1件💪🐶",
    "[hr]",
    `• 発生 : ${when}`,
    `• 通話ID : ${cid}`,
    `• ルート : ${ev.source === "v3" ? "Developer Webhook(v3)" : "Workflow Webhook"}`,
    "[/info]",
  ].join("\n");
}
async function notifyChatworkAppointment(ev: Normalized) {
  const text = formatChatworkMessage(ev);
  if (DRY_RUN) {
    log(`[Chatwork] (DRY_RUN) ${text.replace(/\n/g, " | ")}`);
    return;
  }
  try {
    const r = await sendChatworkMessage(text);
    if (!(r as any).success) {
      console.error("[chatwork] failed", (r as any).status, (r as any).json);
    } else {
      log(`[chatwork] sent status=${(r as any).status}`);
    }
  } catch (e: any) {
    console.error("[chatwork] error", e?.message || e);
  }
}

// ====================== CSV 補助UI/カタログ/URL取込 ==========================
app.get("/admin/template.csv", (_req, res) => {
  const csv =
    "type,email,amount,maker,id,date,notes\n" +
    "approval,info@example.com,0,,A-001,2025-09-08,承認OK\n" +
    "sales,info@example.com,150000,,S-001,2025-09-08,受注\n" +
    "maker,info@example.com,,ACME,M-ACME-1,2025-09-08,最多メーカー\n";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="template.csv"'
  );
  res.send(csv);
});

app.get("/admin/files", (req, res) => {
  if (!requireBearerCsv(req, res)) return;
  res.json({ ok: true, items: loadCsvCatalog() });
});

app.post("/admin/import-url", async (req, res) => {
  if (!requireBearerCsv(req, res)) return;
  try {
    const url = String((req as any).body?.url || "");
    if (!/^https?:\/\//i.test(url))
      return res.status(400).json({ ok: false, error: "invalid_url" });
    if (!hostAllowed(url))
      return res.status(400).json({ ok: false, error: "host_not_allowed" });
    const r = await fetch(url as any);
    const text = await (r as any).text();
    if (!(r as any).ok)
      return res.status(502).json({
        ok: false,
        error: "fetch_failed",
        status: (r as any).status,
        body: text.slice(0, 200),
      });
    return _handleCsvText(text, req, res);
  } catch (e: any) {
    console.error("[admin/import-url]", e?.message || e);
    return res.status(500).json({ ok: false, error: "exception" });
  }
});

app.get("/admin/upload", (_req, res) => {
  const html = `<!doctype html>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>CSV取込（手動）</title>
<style>
 body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;max-width:860px;margin:2rem auto;padding:0 1rem;}
 header{display:flex;gap:.75rem;align-items:center;justify-content:space-between;flex-wrap:wrap}
 input,button,textarea{font:inherit}
 textarea{width:100%;min-height:180px;padding:.6rem;border:1px solid #ddd;border-radius:8px}
 .row{display:flex;gap:.75rem;align-items:center;flex-wrap:wrap;margin:.5rem 0}
 .card{border:1px solid #eee;border-radius:12px;padding:1rem;margin:1rem 0;background:#fafafa}
 .hint{color:#666;font-size:.9rem}
 .mono{font-family:ui-monospace,Menlo,Consolas,monospace}
 .pill{padding:.25rem .5rem;border-radius:999px;background:#eef;border:1px solid #dde}
 .drop{border:2px dashed #9db3ff;border-radius:12px;padding:30px;text-align:center;background:#f7f9ff;color:#334;transition:.15s}
 .drop.drag{background:#eef3ff}
</style>
<header>
  <h1>CSV取込（手動アップロード）</h1>
  <a class="pill" href="/admin/template.csv">⬇ テンプレCSVをダウンロード</a>
</header>
<div class="card">
  <div class="row">
    <label>Base URL</label>
    <input id="base" size="40" value="${PUBLIC_BASE_URL || ""}" placeholder="https://..."/>
  </div>
  <div class="row">
    <label>AUTH_TOKEN</label>
    <input id="token" size="40" placeholder="Bearer用トークン" />
    <button id="save">保存</button><span id="saved" class="hint"></span>
  </div>
  <p class="hint">※ TokenとBase URLはブラウザのlocalStorageに保存されます（サーバには送信されません）。</p>
</div>
<div class="card">
  <h3>ファイルを選んでアップロード</h3>
  <div class="row"><input type="file" id="file" accept=".csv,text/csv" /><button id="upload">アップロード</button></div>
  <p class="hint">MIMEが text/csv でなくても “.csv” なら受理します。</p>
</div>
<div class="card">
  <h3>ドラッグ&ドロップで送信</h3>
  <div id="drop" class="drop">ここに CSV をドラッグ&ドロップ</div>
</div>
<div class="card">
  <h3>CSVを直接貼り付けて送信</h3>
  <textarea id="csv" placeholder="type,email,amount,maker,id,date,notes&#10;approval,info@example.com,0,,A-001,2025-09-08,承認OK"></textarea>
  <div class="row"><button id="send">貼り付けCSVを送信</button></div>
</div>
<div id="out" class="card mono"></div>
<script>
const qs=(s)=>document.querySelector(s);
const baseEl=qs('#base'), tokenEl=qs('#token'), out=qs('#out'), saved=qs('#saved');
function load(){
  baseEl.value = localStorage.getItem('adm_base') || baseEl.value;
  tokenEl.value = localStorage.getItem('adm_token') || '';
  const p = new URLSearchParams(location.search); let changed=false;
  if(p.get('base')){ baseEl.value = p.get('base'); changed=true; }
  if(p.get('token')){ tokenEl.value = p.get('token'); changed=true; }
  if(changed){ save(); history.replaceState({}, '', location.pathname); }
  if(p.get('auto')==='1'){ qs('#file').click(); }
}
function save(){ localStorage.setItem('adm_base', baseEl.value.trim()); localStorage.setItem('adm_token', tokenEl.value.trim()); saved.textContent='保存しました'; setTimeout(()=>saved.textContent='',1500); }
function pr(x){ out.textContent = typeof x==='string' ? x : JSON.stringify(x,null,2); }
async function postCsvRaw(text){
  const base=baseEl.value.trim(); const tok=tokenEl.value.trim(); if(!base||!tok) return pr('Base/Tokenを入力');
  const r=await fetch(base.replace(/\\/$/,'')+'/admin/csv',{ method:'POST', headers:{'Content-Type':'text/csv','Authorization':'Bearer '+tok}, body:text });
  const t=await r.text(); try{ pr(JSON.parse(t)); }catch{ pr(t); }
}
async function postCsvFile(file){
  const base=baseEl.value.trim(); const tok=tokenEl.value.trim(); if(!base||!tok) return pr('Base/Tokenを入力');
  const fd=new FormData(); fd.append('file', file, file.name);
  const r=await fetch(base.replace(/\\/$/,'')+'/admin/csv',{ method:'POST', headers:{'Authorization':'Bearer '+tok}, body:fd });
  const t=await r.text(); try{ pr(JSON.parse(t)); }catch{ pr(t); }
}
qs('#save').onclick=save;
qs('#send').onclick=()=>postCsvRaw(qs('#csv').value);
qs('#upload').onclick=()=>{ const f=qs('#file').files[0]; if(!f) return pr('CSVファイルを選択してください'); postCsvFile(f); };
const drop=qs('#drop');
['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();e.stopPropagation();drop.classList.add('drag');}));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();e.stopPropagation();drop.classList.remove('drag');}));
drop.addEventListener('drop',e=>{const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]; if(!f) return pr('ファイルが取得できませんでした'); postCsvFile(f);});
qs('#csv').addEventListener('keydown',(e)=>{ if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){ e.preventDefault(); qs('#send').click(); }});
load();
</script>`;
  res.type("html").send(html);
});

// ---- CSV Catalog helpers ---------------------------------------------------
type CsvCatalogItem = { id: string; label: string; url: string };
function loadCsvCatalog(): CsvCatalogItem[] {
  const arr = safeParse<any[]>(CSV_CATALOG_JSON) || [];
  const out: CsvCatalogItem[] = [];
  for (const x of arr) {
    if (!x) continue;
    const id = String(x.id || x.label || x.url || "").trim();
    const label = String(x.label || x.id || x.url || "").trim();
    const url = String(x.url || "").trim();
    if (!id || !label || !/^https?:\/\//i.test(url)) continue;
    out.push({ id, label, url });
  }
  return out;
}
function hostAllowed(u: string) {
  try {
    const h = new URL(u).host.toLowerCase();
    if (CSV_ALLOWLIST_HOSTS.length === 0) return /^https:\/\//i.test(u);
    return CSV_ALLOWLIST_HOSTS.includes(h);
  } catch {
    return false;
  }
}

// ====================== ダッシュボード ======================================
app.get("/admin/dashboard", (_req, res) => {
  function readJsonl(fp: string): any[] {
    try {
      return fs
        .readFileSync(fp, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s));
    } catch {
      return [];
    }
  }
  const today = isoDay();
  const yest = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return isoDay(d);
  })();
  const files = {
    calls: readJsonl("data/events/calls.jsonl"),
    appts: readJsonl("data/events/appointments.jsonl"),
    apprs: readJsonl("data/events/approvals.jsonl"),
    sales: readJsonl("data/events/sales.jsonl"),
  };
  function agg(day: string) {
    const by: Record<string, any> = {};
    const nameOf = (a: any) =>
      a?.actor?.name || (a?.email?.split?.("@")[0]) || "担当者";
    for (const a of files.calls.filter((x) => x.day === day)) {
      const k = nameOf(a);
      by[k] ??= { name: k, calls: 0, min: 0, appts: 0, apprs: 0, sales: 0 };
      by[k].calls += 1;
      by[k].min += Math.round((a.ms || 0) / 60000);
    }
    for (const a of files.appts.filter((x) => x.day === day)) {
      const k = nameOf(a);
      by[k] ??= { name: k, calls: 0, min: 0, appts: 0, apprs: 0, sales: 0 };
      by[k].appts += 1;
    }
    for (const a of files.apprs.filter((x) => x.day === day)) {
      const k = nameOf(a);
      by[k] ??= { name: k, calls: 0, min: 0, appts: 0, apprs: 0, sales: 0 };
      by[k].apprs += 1;
    }
    for (const a of files.sales.filter((x) => x.day === day)) {
      const k = nameOf(a);
      by[k] ??= { name: k, calls: 0, min: 0, appts: 0, apprs: 0, sales: 0 };
      by[k].sales += Number(a.amount || 0);
    }
    for (const k of Object.keys(by)) {
      const v = by[k];
      v.rate = v.appts > 0 ? Math.round((v.apprs / v.appts) * 100) : 0;
    }
    return Object.values(by).sort((a: any, b: any) =>
      a.name.localeCompare(b.name)
    );
  }
  function aggMakers(day: string) {
    const by: Record<string, { maker: string; count: number; sales: number }> =
      {};
    for (const a of files.apprs.filter((x) => x.day === day)) {
      const m = (a.maker || "").trim();
      if (!m) continue;
      by[m] ??= { maker: m, count: 0, sales: 0 };
      by[m].count += 1;
    }
    for (const s of files.sales.filter((x) => x.day === day)) {
      const m = (s.maker || "").trim();
      if (!m) continue;
      by[m] ??= { maker: m, count: 0, sales: 0 };
      by[m].sales += Number(s.amount || 0);
    }
    return Object.values(by).sort(
      (a, b) => b.count - a.count || b.sales - a.sales || a.maker.localeCompare(b.maker)
    );
  }

  const T = agg(today),
    Y = agg(yest);
  const TM = aggMakers(today),
    YM = aggMakers(yest);
  const Row = (r: any) =>
    `<tr><td>${r.name}</td><td style="text-align:right">${r.calls}</td><td style="text-align:right">${r.min}</td><td style="text-align:right">${r.appts}</td><td style="text-align:right">${r.apprs}</td><td style="text-align:right">${r.rate}%</td><td style="text-align:right">¥${(
      r.sales || 0
    ).toLocaleString()}</td></tr>`;
  const RowM = (r: any) =>
    `<tr><td>${r.maker}</td><td style="text-align:right">${r.count}</td><td style="text-align:right">¥${(
      r.sales || 0
    ).toLocaleString()}</td></tr>`;

  const html = `<!doctype html><meta charset="utf-8"><title>ダッシュボード</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;margin:2rem}table{border-collapse:collapse;min-width:720px}th,td{border:1px solid #ddd;padding:.5rem .6rem}th{background:#f7f7f7}h2{margin-top:2rem}</style>
  <h1>ダッシュボード</h1>
  <h2>本日 ${today}</h2><table><thead><tr><th>担当</th><th>コール</th><th>分</th><th>アポ</th><th>承認</th><th>承認率</th><th>売上</th></tr></thead>
  <tbody>${T.map(Row).join("") || '<tr><td colspan="7">データなし</td></tr>'}</tbody></table>
  <h2>メーカー別（承認ベース） 本日 ${today}</h2><table><thead><tr><th>メーカー</th><th>承認数</th><th>売上(合計)</th></tr></thead>
  <tbody>${TM.map(RowM).join("") || '<tr><td colspan="3">データなし</td></tr>'}</tbody></table>
  <h2>前日 ${yest}</h2><table><thead><tr><th>担当</th><th>コール</th><th>分</th><th>アポ</th><th>承認</th><th>承認率</th><th>売上</th></tr></thead>
  <tbody>${Y.map(Row).join("") || '<tr><td colspan="7">データなし</td></tr>'}</tbody></table>
  <h2>メーカー別（承認ベース） 前日 ${yest}</h2><table><thead><tr><th>メーカー</th><th>承認数</th><th>売上(合計)</th></tr></thead>
  <tbody>${YM.map(RowM).join("") || '<tr><td colspan="3">データなし</td></tr>'}</tbody></table>`;
  res.type("html").send(html);
});

// ====================== メーカー賞 ==========================================
type MakerAwardWinner = { maker: string; name: string; email?: string; count: number };
const MAKER_AWARD_LOG = "data/events/maker_awards.jsonl";
function hasMakerAwardRecord(day: string, maker: string, name: string) {
  const arr = readJsonlAll(MAKER_AWARD_LOG);
  const id = `${day}|${maker}|${name}`;
  return arr.some((x) => x && x.id === id);
}
function writeMakerAwardRecord(
  day: string,
  maker: string,
  name: string,
  email?: string,
  count?: number
) {
  appendJsonl(MAKER_AWARD_LOG, {
    at: new Date().toISOString(),
    day,
    maker,
    actor: { name, email: email || null },
    count: count ?? 0,
    id: `${day}|${maker}|${name}`,
  });
}
function aggregateMakerWinners(day: string): MakerAwardWinner[] {
  const apprs = readJsonlAll("data/events/approvals.jsonl").filter(
    (x) => x.day === day
  );
  const table: Record<string, Record<string, { count: number; email?: string }>> = {};
  for (const a of apprs) {
    const maker = (a.maker || "").trim();
    if (!maker) continue;
    const name: string =
      (a.actor && a.actor.name) ||
      (a.email && String(a.email).split("@")[0]) ||
      "担当者";
    const email: string | undefined = a.actor?.email || a.email || NAME2MAIL[name];
    table[maker] ??= {};
    table[maker][name] ??= { count: 0, email };
    table[maker][name].count += 1;
    if (email) table[maker][name].email = email;
  }
  const winners: MakerAwardWinner[] = [];
  for (const maker of Object.keys(table)) {
    const rows = Object.entries(table[maker]).map(([name, v]) => ({
      name,
      ...v,
    }));
    if (rows.length === 0) continue;
    const max = Math.max(...rows.map((r) => r.count));
    if (max <= 0) continue;
    for (const r of rows.filter((x) => x.count === max)) {
      winners.push({ maker, name: r.name, email: r.email, count: r.count });
    }
  }
  winners.sort(
    (a, b) => a.maker.localeCompare(b.maker) || a.name.localeCompare(b.name)
  );
  return winners;
}
function formatMakerAwardMessage(
  day: string,
  winners: MakerAwardWinner[],
  applied: boolean
) {
  if (winners.length === 0)
    return ["[info]", `[title]🏆 メーカー賞（${day}）[/title]`, "該当なし（承認データがありません）", "[/info]"].join(
      "\n"
    );
  const lines: string[] = [];
  lines.push("[info]");
  lines.push(`[title]🏆 メーカー賞（${day}）[/title]`);
  const byMaker: Record<string, MakerAwardWinner[]> = {};
  for (const w of winners) {
    byMaker[w.maker] ??= [];
    byMaker[w.maker].push(w);
  }
  for (const mk of Object.keys(byMaker)) {
    const xs = byMaker[mk].map((w) => `${w.name}（${w.count}件）`).join("、");
    lines.push(`• ${mk} : ${xs}`);
  }
  lines.push("[hr]");
  lines.push(
    applied ? "受賞者に称号(+1)を付与しました（Habitica）。" : "※プレビュー（付与は未実行）"
  );
  lines.push("[/info]");
  return lines.join("\n");
}
async function applyMakerAwards(day: string, winners: MakerAwardWinner[]) {
  for (const w of winners) {
    if (hasMakerAwardRecord(day, w.maker, w.name)) {
      log(`[maker-award] skip already awarded: ${day} ${w.maker} ${w.name}`);
      continue;
    }
    const email = w.email || NAME2MAIL[w.name];
    const cred = getHabiticaCredFor(email);
    if (!DRY_RUN && cred) {
      try {
        await addMakerAward(cred, 1);
        writeMakerAwardRecord(day, w.maker, w.name, email, w.count);
        log(`[maker-award] +1 to ${w.name} (${w.maker})`);
      } catch (e) {
        console.error("[maker-award] habitica failed", (e as any)?.message || e);
      }
    } else {
      log(`[maker-award] DRY_RUN or no-cred: ${w.name} (${w.maker})`);
      writeMakerAwardRecord(day, w.maker, w.name, email, w.count);
    }
  }
}
async function runMakerAward(dayRaw: string, apply: boolean) {
  const day = isoDay(dayRaw);
  const winners = aggregateMakerWinners(day);
  if (apply) await applyMakerAwards(day, winners);
  const msg = formatMakerAwardMessage(day, winners, apply);
  try {
    await sendChatworkMessage(msg);
  } catch {}
  return { day, winners, applied: apply };
}

// API: メーカー賞 実行
app.post("/admin/award/maker", async (req, res) => {
  if (!requireBearer(req, res)) return;
  try {
    const day = String((req as any).query?.day || isoDay());
    const apply = String((req as any).query?.apply || "1") !== "0";
    const result = await runMakerAward(day, apply);
    res.json({ ok: true, ...result });
  } catch (e: any) {
    console.error("[/admin/award/maker]", e?.message || e);
    res.status(500).json({ ok: false, error: "exception" });
  }
});

// ---- Debug -----------------------------------------------------------------
app.get("/debug/last", (req, res) => {
  if (!requireBearer(req, res)) return;
  if (!lastEvent.at) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, last_event: lastEvent });
});
app.get("/debug/recent", (req, res) => {
  if (!requireBearer(req, res)) return;
  res.json({ ok: true, recent });
});
app.get("/debug/secret-hint", (req, res) => {
  if (!requireBearer(req, res)) return;
  const secret = WEBHOOK_SECRET || "";
  const hash = crypto.createHash("sha256").update(secret).digest("hex");
  res.json({ ok: true, present: !!secret, length: secret.length, sha256_12: hash.slice(0, 12) });
});

// ---- Start -----------------------------------------------------------------
app.listen(PORT, () => {
  log(`gamify-web listening on :${PORT} (TZ=${process.env.TZ || "Asia/Tokyo"})`);
  log(
    `webhook-ready (v3 rawBody=on, redirect=${HUBSPOT_REDIRECT_URI}, secret=${
      WEBHOOK_SECRET ? "present" : "MISSING"
    }, baseUrl=${PUBLIC_BASE_URL || "n/a"}, DRY_RUN=${DRY_RUN}, appointmentValues=${APPOINTMENT_VALUES.join(
      "|"
    )})`
  );
  log(
    `[habitica] user map loaded: ${
      Object.keys(buildHabiticaMap(HABITICA_USERS_JSON)).length
    } users`
  );
  log(
    `[name->email] map loaded: ${
      Object.keys(buildNameEmailMap(NAME_EMAIL_MAP_JSON)).length
    } entries`
  );
});

export {};
