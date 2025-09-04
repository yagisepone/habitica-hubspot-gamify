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
 * - POST /webhooks/hubspot      // HubSpot Webhook v3: verify -> 204 ACK
 * - GET  /debug/last            // requires Bearer
 * - GET  /debug/secret-hint     // requires Bearer
 */

// ---------------------------------------------------------
// Express
// ---------------------------------------------------------
const app = express();
app.set("x-powered-by", false);
app.set("trust proxy", true);

// ✅ JSON をパースする前に raw を確保しておく（ここが肝）
app.use(
  express.json({
    verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
      (req as any).rawBody = Buffer.from(buf); // 生バイト
    },
  })
);

// ---------------------------------------------------------
// Env
// ---------------------------------------------------------
const PORT = Number(process.env.PORT || 10000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

const WEBHOOK_SECRET =
  process.env.HUBSPOT_WEBHOOK_SIGNING_SECRET ||
  process.env.HUBSPOT_CLIENT_SECRET ||
  process.env.HUBSPOT_APP_SECRET ||
  "";

const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID || "";
const HUBSPOT_APP_SECRET =
  process.env.HUBSPOT_APP_SECRET || process.env.HUBSPOT_CLIENT_SECRET || "";
const HUBSPOT_REDIRECT_URI =
  process.env.HUBSPOT_REDIRECT_URI ||
  "https://sales-gamify.onrender.com/oauth/callback";

// ---------------------------------------------------------
// Utils
// ---------------------------------------------------------
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

// ---------------------------------------------------------
// Last event (debug)
// ---------------------------------------------------------
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

// ---------------------------------------------------------
// Health / Support
// ---------------------------------------------------------
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    tz: process.env.TZ || "Asia/Tokyo",
    now: new Date().toISOString(),
    hasSecret: !!WEBHOOK_SECRET,
  });
});
app.get("/support", (_req, res) =>
  res.type("text/plain").send("Support page (placeholder).")
);

// ---------------------------------------------------------
// OAuth callback (optional)
// ---------------------------------------------------------
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
    res
      .type("text/plain")
      .send("Connected! You can close this window. (OAuth token issued)");
  } catch (e) {
    console.error(e);
    res.status(500).type("text/plain").send("token exchange error");
  }
});

// ---------------------------------------------------------
// HubSpot Webhook v3
// HMAC-SHA256(secret, METHOD + REQUEST_URI + RAW_BODY + TIMESTAMP) -> base64
// REQUEST_URI は withQuery と pathOnly の両方（末尾スラッシュ有無も）を試す
// 204 を即返却（HubSpot 推奨）
// ---------------------------------------------------------
app.post("/webhooks/hubspot", async (req: Request & { rawBody?: Buffer }, res: Response) => {
  const method = (req.method || "POST").toUpperCase();
  const withQuery = (req as any).originalUrl || (req as any).url || "/webhooks/hubspot";
  const urlObj = new URL(withQuery, "http://dummy.local");
  const pathOnly = urlObj.pathname;

  const ts = req.header("x-hubspot-request-timestamp") || "";
  const sig = req.header("x-hubspot-signature-v3") || "";

  // 生ボディ（なければ安全側で JSON stringify）
  const raw: Buffer =
    (req as any).rawBody ??
    Buffer.from(JSON.stringify((req as any).body ?? ""), "utf8");

  const norm = (u: string) => (u.endsWith("/") ? u.slice(0, -1) : u + "/");
  const urls = [withQuery, norm(withQuery), pathOnly, norm(pathOnly)];

  // 4 パターンをバッファ連結で厳密に計算
  const digests = urls.map((u) => {
    const base = Buffer.concat([
      Buffer.from(method, "utf8"),
      Buffer.from(u, "utf8"),
      raw,
      Buffer.from(ts, "utf8"),
    ]);
    return crypto.createHmac("sha256", WEBHOOK_SECRET).update(base).digest("base64");
  });

  const idx = digests.findIndex((d) => timingEqual(d, sig));
  const verified = idx >= 0;

  // 即時 ACK
  res.status(204).end();

  // ログ保存（解析用）
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
    ? { matched: ["withQuery", "withQueryNorm", "pathOnly", "pathOnlyNorm"][idx] }
    : {
        reason: "mismatch",
        method,
        withQuery,
        pathOnly,
        ts,
        sig_first12: sig.slice(0, 12),
        calc_first12: digests.map((d) => d.slice(0, 12)),
      };

  log(`received path=${withQuery} verified=${verified} note=${lastEvent.note}`);
  if (verified && Array.isArray(parsed)) {
    log(`accepted events: ${parsed.length}`);
    // TODO: 必要ならキューやDBへ
  }
});

// ---------------------------------------------------------
// Debug
// ---------------------------------------------------------
app.get("/debug/last", (req, res) => {
  if (!requireBearer(req, res)) return;
  if (!lastEvent.at) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, last_event: lastEvent });
});
app.get("/debug/secret-hint", (req, res) => {
  if (!requireBearer(req, res)) return;
  const secret = WEBHOOK_SECRET || "";
  const hash = crypto.createHash("sha256").update(secret).digest("hex");
  res.json({ ok: true, present: !!secret, length: secret.length, sha256_12: hash.slice(0, 12) });
});

// ---------------------------------------------------------
// Start
// ---------------------------------------------------------
app.listen(PORT, () => {
  log(`gamify-web listening on :${PORT} (TZ=${process.env.TZ || "Asia/Tokyo"})`);
  log(
    `webhook-ready (HubSpot v3, rawBody=on, redirect=${HUBSPOT_REDIRECT_URI}, secret=${
      WEBHOOK_SECRET ? "present" : "MISSING"
    })`
  );
});
