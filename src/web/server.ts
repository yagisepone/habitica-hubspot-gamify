// src/web/server.ts
import express, { Request, Response } from "express";
import crypto from "crypto";
import { handleHubSpotWebhook } from "../handlers/webhooks";

// ====== 小型ユーティリティ ======
type RawReq = Request & { rawBody?: string; __verified?: boolean };

function log(...args: any[]) {
  console.log("[web]", ...args);
}

function safeTimingEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a || "", "utf8");
  const bb = Buffer.from(b || "", "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ====== サーバ起動設定 ======
const app = express();
app.set("x-powered-by", false);
app.set("trust proxy", true);

// 署名検証のために *生のボディ* を保持
app.use(
  express.json({
    verify: (req: RawReq, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

// ====== 環境変数 ======
const PORT = Number(process.env.PORT || 10000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

// Webhook 署名シークレット（専用 > App Secret > Client Secret）
const WEBHOOK_SECRET =
  process.env.HUBSPOT_WEBHOOK_SIGNING_SECRET ||
  process.env.HUBSPOT_APP_SECRET ||
  process.env.HUBSPOT_CLIENT_SECRET ||
  "";

// OAuth 用
const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID || "";
const HUBSPOT_APP_SECRET =
  process.env.HUBSPOT_APP_SECRET || process.env.HUBSPOT_CLIENT_SECRET || "";
const HUBSPOT_REDIRECT_URI =
  process.env.HUBSPOT_REDIRECT_URI ||
  "https://sales-gamify.onrender.com/oauth/callback";

// ====== デバッグ用の最新イベント保持 ======
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

// ====== 共通ヘルパ ======
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

function record(req: RawReq, verified: boolean, note: string, sig_debug?: any) {
  lastEvent.at = new Date().toISOString();
  lastEvent.path = req.path || req.originalUrl;
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
  log(
    `received path=${req.originalUrl || req.path} verified=${verified} note=${note}`
  );
}

/** HubSpot v3 署名検証（末尾スラッシュ差異に耐性 & デバッグ情報付き） */
function verifyHubSpotV3(
  req: RawReq,
  appSecret: string
): { ok: boolean; debug?: any } {
  if (!appSecret) return { ok: false, debug: { reason: "missing secret" } };

  const sig = req.header("x-hubspot-signature-v3") || "";
  const ts = req.header("x-hubspot-request-timestamp") || "";
  if (!sig || !ts)
    return { ok: false, debug: { reason: "missing header", sig, ts } };

  const method = (req.method || "POST").toUpperCase();

  // originalUrl はクエリも含む。なければ url → 最後にパスだけにフォールバック
  const withQuery = (req.originalUrl || req.url || "/webhooks/hubspot").replace(
    /\/{2,}/g,
    "/"
  );
  const noQuery = withQuery.split("?")[0];

  const body = req.rawBody || "";

  // パス末尾の「ある/ない」双方を試す
  const candidates = [
    withQuery.endsWith("/") ? withQuery.slice(0, -1) : withQuery,
    withQuery.endsWith("/") ? withQuery : withQuery + "/",
    noQuery.endsWith("/") ? noQuery.slice(0, -1) : noQuery,
    noQuery.endsWith("/") ? noQuery : noQuery + "/",
  ];

  const digests = candidates.map((uri) =>
    crypto.createHmac("sha256", appSecret).update(method + uri + body + ts).digest("base64")
  );

  const okIndex = digests.findIndex((d) => safeTimingEqual(d, sig));

  return okIndex >= 0
    ? { ok: true, debug: { matched: candidates[okIndex] } }
    : {
        ok: false,
        debug: {
          reason: "mismatch",
          method,
          withQuery,
          noQuery,
          tried: candidates,
          sig_first12: sig.slice(0, 12),
          calc_first12: digests.map((d) => d.slice(0, 12)),
        },
      };
}

// ====== ルート ======
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    tz: process.env.TZ || "Asia/Tokyo",
    now: new Date().toISOString(),
  });
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
    } as any);

    const json = await r.json();
    if (!r.ok) {
      console.error("[oauth] token exchange failed:", json);
      return res.status(502).type("text/plain").send("token exchange failed");
    }

    oauth.at = new Date().toISOString();
    oauth.hub_id = (json as any).hub_id;
    oauth.access_token = (json as any).access_token;
    oauth.refresh_token = (json as any).refresh_token;
    oauth.expires_in = (json as any).expires_in;

    console.log("[oauth] token exchange ok hub_id=", (json as any).hub_id);
    res
      .type("text/plain")
      .send("Connected! You can close this window. (OAuth token issued)");
  } catch (e) {
    console.error(e);
    res.status(500).type("text/plain").send("token exchange error");
  }
});

/**
 * Webhook 本体:
 * 1) 署名検証
 * 2) 受領を記録
 * 3) **204 No Content を即返す**（HubSpot 推奨）
 * 4) setImmediate で handleHubSpotWebhook を非同期実行
 */
app.post("/webhooks/hubspot", (req: RawReq, res: Response) => {
  const v = verifyHubSpotV3(req, WEBHOOK_SECRET);
  if (!v.ok) {
    record(req, false, "invalid-signature", v.debug);
    return res.status(401).json({ ok: false, error: "invalid signature" });
  }

  // 検証OKを示して記録
  req.__verified = true;
  record(req, true, "hubspot-event");

  // 204 を即返す（タイムアウト回避）
  res.status(204).end();

  // 本処理は裏で実行（レスポンスは捨てる）
  setImmediate(() => {
    try {
      const rawBody = req.rawBody;
      const body = (req as any).body;

      // handler に渡すため最小限のダミー res
      const dummyRes = {
        status() {
          return this;
        },
        json() {
          /* no-op */
          return this;
        },
        type() {
          return this;
        },
        send() {
          /* no-op */
          return this;
        },
        end() {
          /* no-op */
        },
      } as unknown as Response;

      // 必要なプロパティだけ複製
      const fakeReq = Object.assign({}, req, { rawBody, body });

      handleHubSpotWebhook(fakeReq as any, dummyRes, () => undefined);
    } catch (e) {
      console.error("[webhook async error]", e);
    }
  });
});

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
      ? {
          at: oauth.at,
          hub_id: oauth.hub_id,
          has_access_token: !!oauth.access_token,
        }
      : null,
  });
});

// ====== boot ======
app.listen(PORT, () => {
  log(`gamify-web listening on :${PORT} (TZ=${process.env.TZ || "Asia/Tokyo"})`);
  log(
    `webhook-ready (HubSpot v3, rawBody on, redirect=${HUBSPOT_REDIRECT_URI})`
  );
});
