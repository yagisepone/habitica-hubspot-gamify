// src/web/server.ts
import express, { Request, Response } from "express";
import crypto from "crypto";

/**
 * === habitica-hubspot-gamify : Web server (Render 用) ===
 * - GET  /healthz
 * - GET  /support
 * - GET  /oauth/callback
 * - POST /webhooks/hubspot   // HubSpot Webhook v3: 署名検証→204即ACK
 * - GET  /debug/last         // 直近受信イベント（Bearer必須）
 * - GET  /debug/secret-hint  // シークレットのヒント（Bearer必須）
 */

type ReqWithRaw = Request & { rawBody?: string };

const app = express();
app.set("x-powered-by", false);
app.set("trust proxy", true);

/**
 * 重要：ここで JSON をパースすると同時に「生の文字列」も保持する。
 * これを使って HMAC を計算するので、/webhooks に別の bodyParser は不要。
 */
app.use(
  express.json({
    verify: (req: ReqWithRaw, _res, buf) => {
      // HubSpotは application/json。生のJSON文字列を保存。
      req.rawBody = buf.toString("utf8");
    },
    limit: "5mb",
  })
);

// ------------------------------------------------------------------
// 環境変数
// ------------------------------------------------------------------
const PORT = Number(process.env.PORT || 10000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

/** Webhook 署名シークレット（優先順） */
const WEBHOOK_SECRET =
  process.env.HUBSPOT_WEBHOOK_SIGNING_SECRET ||
  process.env.HUBSPOT_CLIENT_SECRET ||
  process.env.HUBSPOT_APP_SECRET ||
  "";

/** OAuth（任意） */
const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID || "";
const HUBSPOT_APP_SECRET =
  process.env.HUBSPOT_APP_SECRET || process.env.HUBSPOT_CLIENT_SECRET || "";
const HUBSPOT_REDIRECT_URI =
  process.env.HUBSPOT_REDIRECT_URI ||
  "https://sales-gamify.onrender.com/oauth/callback";

// ------------------------------------------------------------------
// ユーティリティ
// ------------------------------------------------------------------
const log = (...a: any[]) => console.log("[web]", ...a);

function requireBearer(req: Request, res: Response): boolean {
  const token = (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
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
function timingEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// ------------------------------------------------------------------
// 直近イベント（デバッグ用）
// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// ヘルス/サポート
// ------------------------------------------------------------------
app.get("/healthz", (_req, res) =>
  res.json({
    ok: true,
    tz: process.env.TZ || "Asia/Tokyo",
    now: new Date().toISOString(),
    hasSecret: !!WEBHOOK_SECRET,
  })
);
app.get("/support", (_req, res) => res.type("text/plain").send("Support page (placeholder)."));

// ------------------------------------------------------------------
// (任意) OAuth コールバック
// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// HubSpot Webhook v3
// HMAC-SHA256(secret, METHOD + REQUEST_URI + RAW_BODY + TIMESTAMP) を Base64
// REQUEST_URI はクエリ付きパス。末尾スラッシュの揺れも吸収。
// 204 を即返却（HubSpot推奨）。署名NGでも 204。
// ------------------------------------------------------------------
app.post("/webhooks/hubspot", (req: ReqWithRaw, res: Response) => {
  const secret = WEBHOOK_SECRET;

  const sig = req.header("x-hubspot-signature-v3") || "";
  const ts = req.header("x-hubspot-request-timestamp") || "";
  const method = (req.method || "POST").toUpperCase();

  const withQuery = (req as any).originalUrl || (req as any).url || "/webhooks/hubspot";
  const urlObj = new URL(withQuery, "http://dummy.local");
  const pathOnly = urlObj.pathname;
  const norm = (u: string) => (u.endsWith("/") ? u.slice(0, -1) : u + "/");

  const raw = req.rawBody ?? ""; // ここが生の JSON 文字列

  const bases = [
    method + withQuery + raw + ts,
    method + norm(withQuery) + raw + ts,
    method + pathOnly + raw + ts,
    method + norm(pathOnly) + raw + ts,
  ];
  const digests = bases.map((b) => crypto.createHmac("sha256", secret).update(b).digest("base64"));
  const hit = digests.findIndex((d) => timingEqual(d, sig));
  const verified = hit >= 0;

  // HubSpotには即ACK
  res.status(204).end();

  // デバッグ保存（表示用にbodyもJSON化しておく）
  let parsed: any = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  lastEvent.at = new Date().toISOString();
  lastEvent.path = withQuery;
  lastEvent.verified = verified;
  lastEvent.note = verified ? "hubspot-event" : "invalid-signature";
  lastEvent.headers = {
    "x-hubspot-signature-v3": sig || undefined,
    "x-hubspot-request-timestamp": ts || undefined,
    "content-type": req.header("content-type") || undefined,
    "user-agent": req.header("user-agent") || undefined,
  };
  lastEvent.body = parsed;
  lastEvent.sig_debug = verified
    ? { matched: ["withQuery", "withQueryNorm", "pathOnly", "pathOnlyNorm"][hit] }
    : {
        reason: "mismatch",
        method,
        withQuery,
        pathOnly,
        sig_first12: sig.slice(0, 12),
        calc_first12: digests.map((d) => d.slice(0, 12)),
      };

  log(`received path=${withQuery} verified=${verified} note=${lastEvent.note}`);
  if (verified) {
    const count = Array.isArray(parsed) ? parsed.length : parsed ? 1 : 0;
    log(`accepted events: ${count}`);
    // TODO: 必要ならここで本処理（キュー/DB）を行う
  }
});

// ------------------------------------------------------------------
// デバッグ
// ------------------------------------------------------------------
app.get("/debug/last", (req, res) => {
  if (!requireBearer(req, res)) return;
  if (!lastEvent.at) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, last_event: lastEvent, oauth_status: null });
});

app.get("/debug/secret-hint", (req, res) => {
  if (!requireBearer(req, res)) return;
  const secret = WEBHOOK_SECRET || "";
  const hash = crypto.createHash("sha256").update(secret).digest("hex");
  res.json({ ok: true, present: !!secret, length: secret.length, sha256_12: hash.slice(0, 12) });
});

// ------------------------------------------------------------------
// 起動
// ------------------------------------------------------------------
app.listen(PORT, () => {
  log(`gamify-web listening on :${PORT} (TZ=${process.env.TZ || "Asia/Tokyo"})`);
  log(
    `webhook-ready (HubSpot v3, rawBody=on, redirect=${HUBSPOT_REDIRECT_URI}, secret=${
      WEBHOOK_SECRET ? "present" : "MISSING"
    })`
  );
});
