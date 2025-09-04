// src/web/server.ts
import express, { Request, Response } from "express";
import crypto from "crypto";

/**
 * === habitica-hubspot-gamify : Web server (Render 用) ===
 *
 * Endpoints
 * - GET  /healthz
 * - GET  /support
 * - GET  /oauth/callback
 * - POST /webhooks/hubspot     // HubSpot Webhook v3（署名検証あり）
 * - POST /webhooks/workflow    // HubSpot ワークフローWebhooks（Bearer検証）
 * - GET  /debug/last           // requires Bearer
 * - GET  /debug/recent         // requires Bearer（直近20件）
 * - GET  /debug/secret-hint    // requires Bearer
 */

const app = express();
app.set("x-powered-by", false);
app.set("trust proxy", true);

// ---- body: raw を保存（必須） --------------------------------------------
app.use(
  express.json({
    verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
      (req as any).rawBody = Buffer.from(buf);
    },
  })
);

// ---- Env -------------------------------------------------------------------
const PORT = Number(process.env.PORT || 10000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const DRY_RUN = String(process.env.DRY_RUN || "1") === "1";

// Developerアプリの App Secret / Client Secret など、v3署名用の秘密
const WEBHOOK_SECRET =
  process.env.HUBSPOT_WEBHOOK_SIGNING_SECRET ||
  process.env.HUBSPOT_APP_SECRET ||
  process.env.HUBSPOT_CLIENT_SECRET ||
  "";

const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID || "";
const HUBSPOT_APP_SECRET =
  process.env.HUBSPOT_APP_SECRET || process.env.HUBSPOT_CLIENT_SECRET || "";
const HUBSPOT_REDIRECT_URI =
  process.env.HUBSPOT_REDIRECT_URI ||
  "https://sales-gamify.onrender.com/oauth/callback";

// 公開URL（例: https://sales-gamify.onrender.com）
// v3の requestUri 計算で「絶対URL」も候補に含めるために使用
const PUBLIC_BASE_URL =
  (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/+$/, "");

// “新規アポ”とみなす outcome 値（内部値/表示ラベルの両方を許容）
const APPOINTMENT_VALUES = (process.env.APPOINTMENT_VALUES || "APPOINTMENT_SCHEDULED,新規アポ")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 重複抑止TTL（秒）
const DEDUPE_TTL_SEC = Number(process.env.DEDUPE_TTL_SEC || 24 * 60 * 60);

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
function timingEqual(a: string, b: string) {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
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

// ---- Debug store -----------------------------------------------------------
interface LastEvent {
  at?: string;
  path?: string;
  verified?: boolean;
  note?: string;
  headers?: Record<string, string | undefined>;
  body?: any;
  sig_debug?: any;
}
const lastEvent: LastEvent = {};
const recent: LastEvent[] = []; // 直近20件
function pushRecent(ev: LastEvent) {
  recent.unshift(JSON.parse(JSON.stringify(ev)));
  if (recent.length > 20) recent.pop();
}

// ---- Dedupe (in-memory) ----------------------------------------------------
const seen = new Map<string, number>(); // id -> epoch(ms)
function hasSeen(id?: string | number | null): boolean {
  if (!id && id !== 0) return false;
  const key = String(id);
  const now = Date.now();
  // Expire old
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
  res.json({
    ok: true,
    tz: process.env.TZ || "Asia/Tokyo",
    now: new Date().toISOString(),
    hasSecret: !!WEBHOOK_SECRET,
    baseUrl: PUBLIC_BASE_URL || null,
    dryRun: DRY_RUN,
  });
});
app.get("/support", (_req, res) =>
  res.type("text/plain").send("Support page (placeholder).")
);

// ---- OAuth callback (任意) -------------------------------------------------
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
    });
    const json = await r.json();
    if (!r.ok) {
      console.error("[oauth] exchange failed:", json);
      return res.status(502).type("text/plain").send("token exchange failed");
    }
    res.type("text/plain").send("Connected! You can close this window. (OAuth token issued)");
  } catch (e) {
    console.error(e);
    res.status(500).type("text/plain").send("token exchange error");
  }
});

// ============================================================================
// HubSpot Webhook v3
// HMAC-SHA256(secret, METHOD + REQUEST_URI + RAW_BODY + TIMESTAMP) -> base64
// REQUEST_URI は Target URL 全体（絶対URL）で計算される場合がある点に注意。
// ============================================================================
app.post("/webhooks/hubspot", async (req: Request & { rawBody?: Buffer }, res: Response) => {
  const method = (req.method || "POST").toUpperCase();
  const withQuery = (req as any).originalUrl || (req as any).url || "/webhooks/hubspot";
  const urlObj = new URL(withQuery, "http://dummy.local");
  const pathOnly = urlObj.pathname + (urlObj.search || "");

  const tsHeader = req.header("x-hubspot-request-timestamp") || "";
  const sigHeader = req.header("x-hubspot-signature-v3") || "";
  const verHeader = (req.header("x-hubspot-signature-version") || "").toLowerCase();

  // 生ボディ（検証は raw で！）
  const raw: Buffer =
    (req as any).rawBody ?? Buffer.from(JSON.stringify((req as any).body ?? ""), "utf8");

  // 候補URI（相対/絶対/末尾スラ・decode/環境変数ベース）を網羅
  const proto =
    String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
    req.protocol ||
    "https";
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
    const h = crypto.createHmac("sha256", WEBHOOK_SECRET).update(base).digest("base64");
    return { uri: u, sig: h };
  });

  const hit = calc.find((c) => timingEqual(c.sig, sigHeader));
  const verified = !!hit;

  // HubSpot推奨：即204返却
  res.status(204).end();

  // 5分超の時刻ズレメモ
  let tsNote: string | undefined;
  const MAX_SKEW_MS = 5 * 60 * 1000;
  const now = Date.now();
  const tsNum = Number(tsHeader);
  if (!Number.isNaN(tsNum) && Math.abs(now - tsNum) > MAX_SKEW_MS) {
    tsNote = "stale_timestamp(>5min)";
  }

  // 解析用
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    parsed = null;
  }

  const sample = calc.slice(0, 6).map((c) => c.sig.slice(0, 12));
  const matched = hit ? hit.uri : undefined;

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
      ? { matchedUri: matched }
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
          calc_first12: sample,
        },
  };
  Object.assign(lastEvent, ev);
  pushRecent(ev);

  log(`received uri=${withQuery} verified=${verified} note=${ev.note}`);

  // ---- 正規化＆処理（v3ボディは配列想定） -------------------------------
  if (verified && Array.isArray(parsed)) {
    for (const e of parsed) {
      // 例：Calls の property change（将来 v3サブスクを使う場合）
      if (
        (String(e.subscriptionType || "").toLowerCase().includes("call") ||
          String(e.objectType || "").toLowerCase().includes("call")) &&
        e.propertyName === "hs_call_disposition"
      ) {
        await handleNormalizedEvent({
          source: "v3",
          eventId: e.eventId ?? e.attemptNumber, // なければattemptなどで代用
          callId: e.objectId,
          outcome: e.propertyValue,
          occurredAt: e.occurredAt,
          raw: e,
        });
      }
      // 既存：deal.propertyChange はここではXP付与しない（仕様外）
    }
  }
});

// ============================================================================
// ワークフロー Webhooks（署名なし・Bearer検証）
// Private App トークンが無くてもUIだけで構成できる確実ルート。
// ============================================================================
app.post("/webhooks/workflow", async (req: Request, res: Response) => {
  const tok = (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!AUTH_TOKEN || tok !== AUTH_TOKEN) {
    return res.status(401).json({ ok: false, error: "auth" });
  }

  const b = (req as any).body || {};
  const outcome =
    b.outcome || b.hs_call_disposition || b.callOutcome || b.properties?.hs_call_disposition;
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
  log(`received path=/webhooks/workflow verified=true outcome=${outcome} callId=${callId}`);

  await handleNormalizedEvent({
    source: "workflow",
    eventId: b.eventId || callId,
    callId,
    outcome,
    occurredAt,
    raw: b,
  });

  return res.json({ ok: true });
});

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

  // “新規アポ”判定
  const isAppointment =
    !!ev.outcome && APPOINTMENT_VALUES.some((v) => String(ev.outcome).trim() === v);

  if (isAppointment) {
    await awardXpForAppointment(ev);
    await notifyChatworkAppointment(ev);
  } else {
    // その他のイベントは必要に応じて拡張
  }
}

async function awardXpForAppointment(ev: Normalized) {
  const msg = `[XP] appointment scheduled (source=${ev.source}) callId=${ev.callId} eventId=${ev.eventId}`;
  if (DRY_RUN) {
    log(`${msg} (DRY_RUN)`);
    return;
  }
  // TODO: Habitica API 呼び出しを実装
  log(msg);
}

async function notifyChatworkAppointment(ev: Normalized) {
  const text = `✅ 新規アポ: callId=${ev.callId ?? "-"} source=${ev.source}`;
  if (DRY_RUN) {
    log(`[Chatwork] ${text} (DRY_RUN)`);
    return;
  }
  // TODO: Chatwork API 呼び出しを実装
  log(`[Chatwork] ${text}`);
}

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
  res.json({
    ok: true,
    present: !!secret,
    length: secret.length,
    sha256_12: hash.slice(0, 12),
  });
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
});

export {};
