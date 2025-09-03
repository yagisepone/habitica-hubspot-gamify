// server.ts  (place this as src/web/server.ts)
import express, { Request, Response } from "express";
import crypto from "crypto";
import { handleHubSpotWebhook } from "../handlers/webhooks";

/**
 * habitica-hubspot-gamify / production server
 *
 * Routes
 * - GET  /healthz
 * - GET  /support
 * - GET  /oauth/callback
 * - POST /webhooks/hubspot   (v3 signature required; verified here → handlerへ委譲)
 * - GET  /debug/last         (Bearer required)
 */

const app = express();
app.set("x-powered-by", false);
app.set("trust proxy", true);

// ===== env =====
const PORT = Number(process.env.PORT || 10000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

// signature secret（Private App の Signing Secret があれば優先。なければ App Secret を使用）
const WEBHOOK_SECRET =
  process.env.HUBSPOT_WEBHOOK_SIGNING_SECRET ||
  process.env.HUBSPOT_APP_SECRET ||
  process.env.HUBSPOT_CLIENT_SECRET ||
  "";

// OAuth envs（CLIENT_SECRET と APP_SECRET は実質同値なのでどちらでもOK）
const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID || "";
const HUBSPOT_APP_SECRET =
  process.env.HUBSPOT_APP_SECRET || process.env.HUBSPOT_CLIENT_SECRET || "";
const HUBSPOT_REDIRECT_URI =
  process.env.HUBSPOT_REDIRECT_URI ||
  "https://sales-gamify.onrender.com/oauth/callback";

// ===== raw body capture for signature (HubSpot は生ボディで署名するため必須) =====
app.use(
  express.json({
    verify: (req: Request & { rawBody?: string }, _res, buf) => {
      (req as any).rawBody = buf.toString("utf8");
    },
  })
);

// ===== in-memory stores =====
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

interface OAuthState {
  at?: string;
  hub_id?: number;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}
const oauth: OAuthState = {};

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

function record(
  req: Request & { rawBody?: string },
  verified: boolean,
  note: string,
  sig_debug?: any
) {
  lastEvent.at = new Date().toISOString();
  lastEvent.path = req.originalUrl;
  lastEvent.verified = verified;
  lastEvent.note = note;
  lastEvent.headers = {
    "x-hubspot-signature-v3": req.header("x-hubspot-signature-v3") || undefined,
    "x-hubspot-request-timestamp":
      req.header("x-hubspot-request-timestamp") || undefined,
    "content-type": req.header("content-type") || undefined,
    "user-agent": req.header("user-agent") || undefined,
  };
  lastEvent.body = (req as any).body;
  if (sig_debug) (lastEvent as any).sig_debug = sig_debug;
  log(`received path=${req.originalUrl} verified=${verified} note=${note}`);
}

function safeTimingEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** HubSpot v3 verifier（クエリ有無 & 末尾スラッシュ有無の全パターンで検証） */
function verifyHubSpotV3(
  req: Request & { rawBody?: string },
  appSecret: string
): { ok: boolean; matched?: string; tried: string[] } {
  if (!appSecret) return { ok: false, tried: ["<missing secret>"] };

  const sig = req.get("X-HubSpot-Signature-v3") || "";
  const ts = req.get("X-HubSpot-Request-Timestamp") || "";
  if (!sig || !ts) return { ok: false, tried: ["<missing headers>"] };

  const method = req.method.toUpperCase();
  const full = req.originalUrl || req.url || "/webhooks/hubspot";
  const [pathOnly] = full.split("?");

  // 4候補：full, full(末尾/付与), pathOnly, pathOnly(末尾/付与)
  const withSlash = full.endsWith("/") ? full : full + "/";
  const pathWithSlash = pathOnly.endsWith("/") ? pathOnly : pathOnly + "/";
  const candidates = [full, withSlash, pathOnly, pathWithSlash];

  const body = req.rawBody || "";
  const tried: string[] = [];

  for (const uri of candidates) {
    const base = method + uri + body + ts;
    const digest = crypto.createHmac("sha256", appSecret).update(base).digest("base64");
    tried.push(`${uri} :: ${digest.slice(0, 12)}`);
    if (safeTimingEqual(digest, sig)) return { ok: true, matched: uri, tried };
  }
  return { ok: false, tried };
}

// ===== routes =====
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, tz: process.env.TZ || "Asia/Tokyo", now: new Date().toISOString() });
});

app.get("/support", (_req, res) => {
  res.type("text/plain").send("Support page (placeholder).");
});

// OAuth callback: code -> token exchange
app.get("/oauth/callback", async (req: Request, res: Response) => {
  const code = String(req.query.code || "");
  if (!code) return res.status(400).type("text/plain").send("missing code");
  if (!HUBSPOT_CLIENT_ID || !HUBSPOT_APP_SECRET) {
    return res
      .status(500)
      .type("text/plain")
      .send("server missing HUBSPOT_CLIENT_ID/HUBSPOT_APP_SECRET");
  }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: HUBSPOT_CLIENT_ID,
      client_secret: HUBSPOT_APP_SECRET,
      redirect_uri: HUBSPOT_REDIRECT_URI,
      code,
    });

    const r = await fetch("https://api.hubapi.com/oauth/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const json = await r.json();
    if (!r.ok) {
      console.error("[oauth] token exchange failed:", json);
      return res.status(502).type("text/plain").send("token exchange failed");
    }

    oauth.at = new Date().toISOString();
    oauth.hub_id = json.hub_id;
    oauth.access_token = json.access_token;
    oauth.refresh_token = json.refresh_token;
    oauth.expires_in = json.expires_in;

    console.log("[oauth] token exchange ok hub_id=", json.hub_id);
    res.type("text/plain").send("Connected! You can close this window. (OAuth token issued)");
  } catch (e) {
    console.error(e);
    res.status(500).type("text/plain").send("token exchange error");
  }
});

// Webhook endpoint: verify here → 本体ハンドラへ委譲
app.post(
  "/webhooks/hubspot",
  async (req: Request & { rawBody?: string }, res: Response) => {
    const v = verifyHubSpotV3(req, WEBHOOK_SECRET);
    if (!v.ok) {
      record(req, false, "invalid-signature", { tried: v.tried });
      return res.status(401).json({ ok: false, error: "invalid signature" });
    }

    // 検証OKを記録してから、本体処理へ
    record(req, true, "hubspot-event", { matched: v.matched });
    return handleHubSpotWebhook(req, res, () => undefined);
  }
);

// Debug endpoint (Bearer required)
app.get("/debug/last", (req: Request, res: Response) => {
  if (!requireBearer(req, res)) return;
  if (!lastEvent.at && !oauth.at) {
    return res.status(404).json({ ok: false, error: "not_found" });
  }
  res.json({
    ok: true,
    last_event: lastEvent.at ? lastEvent : null,
    oauth_status: oauth.at
      ? { at: oauth.at, hub_id: oauth.hub_id, has_access_token: !!oauth.access_token }
      : null,
  });
});

// boot
app.listen(PORT, () => {
  log(`gamify-web listening on :${PORT} (TZ=${process.env.TZ || "Asia/Tokyo"})`);
  log(`webhook-ready (HubSpot v3, rawBody on, redirect=${HUBSPOT_REDIRECT_URI})`);
});
