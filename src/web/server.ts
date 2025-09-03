// server.ts  (place this as src/web/server.ts)
import express, { Request, Response } from "express";
import crypto from "crypto";

/**
 * habitica-hubspot-gamify / production server
 *
 * Routes
 * - GET  /healthz            : liveness
 * - GET  /support            : placeholder page (OK to keep)
 * - GET  /oauth/callback     : HubSpot OAuth token exchange (permanent fix)
 * - POST /webhooks/hubspot   : HubSpot Webhooks v3 (signature required)
 * - GET  /debug/last         : last webhook + oauth status (Bearer required)
 *
 * Required ENVs (Render → Environment):
 *   PORT=10000
 *   TZ=Asia/Tokyo
 *   AUTH_TOKEN=your-long-random-token
 *
 *   // for signature verification (App Secret)
 *   HUBSPOT_WEBHOOK_SIGNING_SECRET=<App Secret>
 *   // for OAuth token exchange
 *   HUBSPOT_CLIENT_ID=<Client ID>
 *   HUBSPOT_APP_SECRET=<App Secret>
 *   // (your project currently uses HUBSPOT_CLIENT_SECRET; we accept both)
 *   HUBSPOT_CLIENT_SECRET=<App Secret>
 *
 *   // redirect URI registered in HubSpot app (Auth → Redirect URL)
 *   HUBSPOT_REDIRECT_URI=https://sales-gamify.onrender.com/oauth/callback
 *
 * Notes:
 * - Node 18+ (global fetch available)
 * - HubSpot v3 signature = HMAC-SHA256(base64) of:
 *     METHOD + requestUri + body + x-hubspot-request-timestamp
 */

const app = express();
app.set("x-powered-by", false);
app.set("trust proxy", true);

// ===== env =====
const PORT = Number(process.env.PORT || 10000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

// signature secret (prefer dedicated var, but fall back to App Secret if needed)
const WEBHOOK_SECRET =
  process.env.HUBSPOT_WEBHOOK_SIGNING_SECRET ||
  process.env.HUBSPOT_APP_SECRET ||
  process.env.HUBSPOT_CLIENT_SECRET ||
  "";

// OAuth envs (accept both *_APP_SECRET and *_CLIENT_SECRET)
const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID || "";
const HUBSPOT_APP_SECRET =
  process.env.HUBSPOT_APP_SECRET || process.env.HUBSPOT_CLIENT_SECRET || "";

const HUBSPOT_REDIRECT_URI =
  process.env.HUBSPOT_REDIRECT_URI ||
  "https://sales-gamify.onrender.com/oauth/callback";

// ===== raw body capture for signature =====
app.use(
  express.json({
    verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
      (req as any).rawBody = Buffer.from(buf);
    },
  })
);

// ===== in-memory stores (replace with DB in production if needed) =====
interface LastEvent {
  at?: string;
  path?: string;
  verified?: boolean;
  note?: string;
  headers?: Record<string, string | undefined>;
  body?: any;
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
  req: Request & { rawBody?: Buffer },
  verified: boolean,
  note: string
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
  log(`received path=${req.originalUrl} verified=${verified} note=${note}`);
}

function safeTimingEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** HubSpot Webhook v3 signature verify */
function verifyHubSpotV3(
  req: Request & { rawBody?: Buffer },
  appSecret: string
): boolean {
  if (!appSecret) return false;
  const sig = req.header("x-hubspot-signature-v3") || "";
  const ts = req.header("x-hubspot-request-timestamp") || "";
  if (!sig || !ts) return false;

  const method = req.method.toUpperCase();
  const requestUri = req.originalUrl; // e.g. /webhooks/hubspot?foo=1
  const body = (req.rawBody || Buffer.from("")).toString("utf8");
  const base = method + requestUri + body + ts;
  const digest = crypto.createHmac("sha256", appSecret).update(base).digest("base64");
  return safeTimingEqual(digest, sig);
}

// ===== routes =====
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, tz: process.env.TZ || "Asia/Tokyo", now: new Date().toISOString() });
});

// keep existing placeholder
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

    // store in memory (replace with DB if you need persistence)
    oauth.at = new Date().toISOString();
    oauth.hub_id = json.hub_id;
    oauth.access_token = json.access_token;
    oauth.refresh_token = json.refresh_token;
    oauth.expires_in = json.expires_in;

    console.log("[oauth] token exchange ok hub_id=", json.hub_id);
    res
      .type("text/plain")
      .send("Connected! You can close this window. (OAuth token issued)");
  } catch (e) {
    console.error(e);
    res.status(500).type("text/plain").send("token exchange error");
  }
});

// Webhook endpoint (signature required)
app.post(
  "/webhooks/hubspot",
  (req: Request & { rawBody?: Buffer }, res: Response) => {
    const ok = verifyHubSpotV3(req, WEBHOOK_SECRET);
    if (!ok) {
      record(req, false, "invalid-signature");
      return res.status(401).json({ ok: false, error: "invalid signature" });
    }

    // TODO: call your real handler here (Habitica/Chatwork etc.)
    // handleHubSpotEvents(req.body)

    record(req, true, "hubspot-event");
    const received = Array.isArray(req.body) ? req.body.length : 1;
    res.json({ ok: true, received });
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
