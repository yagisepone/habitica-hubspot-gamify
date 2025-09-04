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
 * - POST /webhooks/hubspot      // HubSpot Webhook v3（署名検証→204即時ACK）
 * - GET  /debug/last            // 直近受信イベント（Bearer 必須）
 * - GET  /debug/secret-hint     // シークレットのヒント（Bearer 必須）
 */

const app = express();
app.set("x-powered-by", false);
app.set("trust proxy", true);

// !!! 重要 !!!
// グローバルの express.json() は webhook より「後」に付ける or 付けない。
// 先に付けると生ボディを消費して署名検証に失敗します。
// （必要なら最下部の「// optional: other routes」で付けられます）

// ──────────────────────────────────────────────────────────
// 環境変数
// ──────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 10000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

// Webhook 署名シークレット（優先順）
const WEBHOOK_SECRET =
  process.env.HUBSPOT_WEBHOOK_SIGNING_SECRET ||
  process.env.HUBSPOT_CLIENT_SECRET ||
  process.env.HUBSPOT_APP_SECRET ||
  "";

// OAuth（任意）
const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID || "";
const HUBSPOT_APP_SECRET =
  process.env.HUBSPOT_APP_SECRET || process.env.HUBSPOT_CLIENT_SECRET || "";
const HUBSPOT_REDIRECT_URI =
  process.env.HUBSPOT_REDIRECT_URI ||
  "https://sales-gamify.onrender.com/oauth/callback";

// ──────────────────────────────────────────────────────────
// ユーティリティ
// ──────────────────────────────────────────────────────────
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
function timingEqual(a: string, b: string): boolean {
  const A = Buffer.from(a, "utf8");
  const B = Buffer.from(b, "utf8");
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// 直近イベント保存（デバッグ用）
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

// ──────────────────────────────────────────────────────────
// ヘルス/サポート
// ──────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) =>
  res.json({
    ok: true,
    tz: process.env.TZ || "Asia/Tokyo",
    now: new Date().toISOString(),
    hasSecret: !!WEBHOOK_SECRET,
  })
);
app.get("/support", (_req, res) => res.type("text/plain").send("Support page (placeholder)."));

// ──────────────────────────────────────────────────────────
// OAuth callback（任意）
// ──────────────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────
// Webhook本体（ここは必ず raw で受ける）
// HMAC-SHA256(secret, METHOD + REQUEST_URI + RAW_BODY + TIMESTAMP) base64
// REQUEST_URI は originalUrl（クエリ含む）。揺れ吸収のため数パターンを試行。
// 204 を即返却（HubSpot 推奨）。
// ──────────────────────────────────────────────────────────
app.post(
  "/webhooks/hubspot",
  express.raw({ type: "*/*", limit: "5mb" }),
  async (req: Request, res: Response) => {
    const method = req.method.toUpperCase();
    const withQuery = (req as any).originalUrl || req.url || "/webhooks/hubspot";
    const pathOnly = withQuery.split("?")[0];
    const norm = (u: string) => (u.endsWith("/") ? u.slice(0, -1) : u + "/");

    const raw: Buffer = Buffer.isBuffer((req as any).body)
      ? (req as any).body
      : Buffer.from(String((req as any).body ?? ""), "utf8");

    const ts = req.header("x-hubspot-request-timestamp") || "";
    const sig = req.header("x-hubspot-signature-v3") || "";

    const variants = [
      { label: "withQuery", url: withQuery },
      { label: "withQueryNorm", url: norm(withQuery) },
      { label: "pathOnly", url: pathOnly },
      { label: "pathOnlyNorm", url: norm(pathOnly) },
    ];

    const calcs = variants.map((v) => {
      const base = Buffer.concat([
        Buffer.from(method, "utf8"),
        Buffer.from(v.url, "utf8"),
        raw,
        Buffer.from(ts, "utf8"),
      ]);
      const digest = crypto.createHmac("sha256", WEBHOOK_SECRET).update(base).digest("base64");
      return { ...v, digest };
    });

    const hit = calcs.find((c) => timingEqual(sig, c.digest));
    const verified = !!hit;

    // 204 即時 ACK
    res.status(204).end();

    // ログ/デバッグ保存（非同期処理はここから）
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
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
      ? { matched: hit?.label }
      : {
          reason: "mismatch",
          method,
          withQuery,
          pathOnly,
          ts,
          sig_first12: sig.slice(0, 12),
          calc_first12: calcs.map((c) => c.digest.slice(0, 12)),
        };

    log(`received path=${withQuery} verified=${verified} note=${lastEvent.note}`);
    if (verified && Array.isArray(parsed)) {
      log(`accepted events: ${parsed.length}`);
      // TODO: ここでキュー投入/DB書き込みなど
    }
  }
);

// ──────────────────────────────────────────────────────────
// デバッグ API
// ──────────────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────
// （必要なら）ここで他ルート向けに JSON パーサを付ける
// app.use(express.json());
// ──────────────────────────────────────────────────────────

// 起動
app.listen(PORT, () => {
  log(`gamify-web listening on :${PORT} (TZ=${process.env.TZ || "Asia/Tokyo"})`);
  log(
    `webhook-ready (HubSpot v3, rawBody=on, redirect=${HUBSPOT_REDIRECT_URI}, secret=${
      WEBHOOK_SECRET ? "present" : "MISSING"
    })`
  );
});
