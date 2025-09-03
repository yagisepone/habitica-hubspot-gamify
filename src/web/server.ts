// src/web/server.ts
import express, { Request, Response, NextFunction } from "express";
import crypto from "crypto";

/**
 * === habitica-hubspot-gamify : Web server (Render 用) ===
 *
 * 主要エンドポイント
 * - GET  /healthz
 * - GET  /support
 * - GET  /oauth/callback        // (任意) OAuth コールバック
 * - POST /webhooks/hubspot      // HubSpot Webhook v3（署名検証して 204 即時 ACK）
 * - GET  /debug/last            // 直近受信イベントの確認（Bearer 必須）
 * - GET  /debug/secret-hint     // 署名シークレットの “ヒント” 表示（漏洩防止のためハッシュのみ／Bearer 必須）
 */

// ------------------------------------------------------------------
// Express 初期化
// ------------------------------------------------------------------
const app = express();
app.set("x-powered-by", false);
app.set("trust proxy", true);

// JSON パーサ（署名計算用に **生のボディ** を保持）
app.use(
  express.json({
    verify: (req: Request & { rawBody?: string }, _res, buf) => {
      (req as any).rawBody = buf.toString("utf8");
    },
  })
);

// ------------------------------------------------------------------
// 環境変数
// ------------------------------------------------------------------
const PORT = Number(process.env.PORT || 10000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

/**
 * Webhook 署名シークレット（優先順）
 * - Private App … HUBSPOT_WEBHOOK_SIGNING_SECRET
 * - Public App  … HUBSPOT_CLIENT_SECRET（＝画面の「クライアントシークレット」）
 *   ※ 一部環境では HUBSPOT_APP_SECRET と表記される場合があるのでフォールバック
 */
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

// ------------------------------------------------------------------
// ユーティリティ
// ------------------------------------------------------------------
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

function safeTimingEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ------------------------------------------------------------------
// v3 署名検証
// 公式仕様: HMAC-SHA256(secret, METHOD + REQUEST_URI + BODY + TIMESTAMP) を Base64
// ※ REQUEST_URI はクエリ付きパス（例: /webhooks/hubspot?x=1）
//   末尾スラッシュ差異による揺れに備えて 2 パターンも試す
// ------------------------------------------------------------------
function verifyHubSpotV3(
  req: Request & { rawBody?: string },
  secret: string
): { ok: boolean; debug: any } {
  if (!secret) return { ok: false, debug: { reason: "missing-secret" } };

  const sig = req.header("x-hubspot-signature-v3") || "";
  const ts = req.header("x-hubspot-request-timestamp") || "";
  if (!sig || !ts) {
    return { ok: false, debug: { reason: "missing-header", sig: !!sig, ts: !!ts } };
  }

  const method = (req.method || "POST").toUpperCase();

  // originalUrl はクエリを含む（望ましい）。なければ url を使用。
  const withQuery = (req as any).originalUrl || (req as any).url || "/webhooks/hubspot";
  const urlObj = new URL(withQuery, "http://dummy.local"); // パースだけ
  const pathOnly = urlObj.pathname; // クエリ無し

  // 末尾スラッシュの正規化
  const norm = (u: string) => (u.endsWith("/") ? u.slice(0, -1) : u + "/");

  const raw = req.rawBody ?? ""; // ここが “生” の JSON 文字列
  const bases = [
    method + withQuery + raw + ts,
    method + norm(withQuery) + raw + ts,
    method + pathOnly + raw + ts,
    method + norm(pathOnly) + raw + ts,
  ];

  const digests = bases.map((b) =>
    crypto.createHmac("sha256", secret).update(b).digest("base64")
  );

  const matchedIndex = digests.findIndex((d) => safeTimingEqual(d, sig));
  const ok = matchedIndex >= 0;

  return {
    ok,
    debug: ok
      ? { matched: ["withQuery", "withQueryNorm", "pathOnly", "pathOnlyNorm"][matchedIndex] }
      : {
          reason: "mismatch",
          method,
          withQuery,
          pathOnly,
          ts,
          sig_first12: sig.slice(0, 12),
          calc_first12: digests.map((d) => d.slice(0, 12)),
        },
  };
}

// ------------------------------------------------------------------
// 直近イベントの保存（デバッグ用）
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
// ルーティング
// ------------------------------------------------------------------
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    tz: process.env.TZ || "Asia/Tokyo",
    now: new Date().toISOString(),
    hasSecret: !!WEBHOOK_SECRET,
  });
});

app.get("/support", (_req, res) => {
  res.type("text/plain").send("Support page (placeholder).");
});

// (任意) OAuth コールバック
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

// HubSpot Webhook 本体（ここで v3 署名を検証 → 204で即時ACK）
app.post(
  "/webhooks/hubspot",
  async (req: Request & { rawBody?: string }, res: Response, _next: NextFunction) => {
    const v = verifyHubSpotV3(req, WEBHOOK_SECRET);

    // デバッグ保存
    lastEvent.at = new Date().toISOString();
    lastEvent.path = req.originalUrl || req.url;
    lastEvent.verified = v.ok;
    lastEvent.note = v.ok ? "hubspot-event" : "invalid-signature";
    lastEvent.headers = {
      "x-hubspot-signature-v3": req.header("x-hubspot-signature-v3") || undefined,
      "x-hubspot-request-timestamp": req.header("x-hubspot-request-timestamp") || undefined,
      "content-type": req.header("content-type") || undefined,
      "user-agent": req.header("user-agent") || undefined,
    };
    lastEvent.body = (req as any).body;
    lastEvent.sig_debug = v.debug;

    if (!v.ok) {
      log(
        `received path=${lastEvent.path} verified=false note=invalid-signature`
      );
      return res.status(401).json({ ok: false, error: "invalid signature" });
    }

    // === ここで 204 を先に返す（HubSpot 推奨：タイムアウト防止） ===
    res.status(204).end();

    // 以降は非同期で本処理（必要ならキューへ）
    try {
      // 例）受け取ったイベントをログに残すだけ
      const payload = Array.isArray(req.body) ? req.body : [];
      log(`accepted events: ${payload.length}`);
      // TODO: 必要ならここでキュー投入／DB書き込みなど
    } catch (e) {
      console.error("[async-handler] error:", e);
    }
  }
);

// デバッグ: 直近イベント（Bearer 必須）
app.get("/debug/last", (req: Request, res: Response) => {
  if (!requireBearer(req, res)) return;
  if (!lastEvent.at) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, last_event: lastEvent });
});

// デバッグ: シークレットの “ヒント” を返す（漏洩防止のためプレーン値は出さない）
app.get("/debug/secret-hint", (req: Request, res: Response) => {
  if (!requireBearer(req, res)) return;
  const secret = WEBHOOK_SECRET || "";
  const hash = crypto.createHash("sha256").update(secret).digest("hex");
  res.json({
    ok: true,
    present: !!secret,
    // 長さとハッシュ先頭のみ（実値は返さない）
    length: secret.length,
    sha256_12: hash.slice(0, 12),
  });
});

// ------------------------------------------------------------------
// 起動
// ------------------------------------------------------------------
app.listen(PORT, () => {
  log(`gamify-web listening on :${PORT} (TZ=${process.env.TZ || "Asia/Tokyo"})`);
  log(
    `webhook-ready (v3 signature; rawBody=on; redirect=${HUBSPOT_REDIRECT_URI}; secret=${
      WEBHOOK_SECRET ? "present" : "MISSING"
    })`
  );
});
