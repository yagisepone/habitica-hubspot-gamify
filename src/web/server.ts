// src/web/server.ts
import express, { Request, Response } from "express";
import crypto from "crypto";

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

// 使うシークレット（開発者アプリの App Secret / Client Secret など）
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

// “絶対URL” を固定で使いたい場合に指定（例: https://sales-gamify.onrender.com）
const PUBLIC_BASE_URL =
  (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/+$/, "");

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

// ---- last event (debug) ----------------------------------------------------
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

// ---- Health / Support ------------------------------------------------------
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    tz: process.env.TZ || "Asia/Tokyo",
    now: new Date().toISOString(),
    hasSecret: !!WEBHOOK_SECRET,
    baseUrl: PUBLIC_BASE_URL || null,
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
    res
      .type("text/plain")
      .send("Connected! You can close this window. (OAuth token issued)");
  } catch (e) {
    console.error(e);
    res.status(500).type("text/plain").send("token exchange error");
  }
});

// ---- HubSpot Webhook v3 ----------------------------------------------------
// HMAC-SHA256(secret, METHOD + REQUEST_URI + RAW_BODY + TIMESTAMP) -> base64
// REQUEST_URI は “Target URL そのもの”（絶対URL）を使う場合がある点に注意。:contentReference[oaicite:1]{index=1}
app.post(
  "/webhooks/hubspot",
  async (req: Request & { rawBody?: Buffer }, res: Response) => {
    const method = (req.method || "POST").toUpperCase();
    const withQuery = (req as any).originalUrl || (req as any).url || "/webhooks/hubspot";
    const urlObj = new URL(withQuery, "http://dummy.local");
    const pathOnly = urlObj.pathname + (urlObj.search || "");

    const tsHeader = req.header("x-hubspot-request-timestamp") || "";
    const sigHeader = req.header("x-hubspot-signature-v3") || "";
    const verHeader = (req.header("x-hubspot-signature-version") || "").toLowerCase();

    // 生ボディ（検証は raw で！）
    const raw: Buffer =
      (req as any).rawBody ??
      Buffer.from(JSON.stringify((req as any).body ?? ""), "utf8");

    // 候補URIを網羅（相対/絶対/スラッシュ/デコード/環境変数ベース）
    const proto =
      String(req.headers["x-forwarded-proto"] || "")
        .split(",")[0]
        .trim() || req.protocol || "https";
    const hostHdr = String(
      req.headers["x-forwarded-host"] || req.headers["host"] || ""
    )
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

    // 署名計算
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

    // 204 を即時返却（HubSpot推奨） :contentReference[oaicite:2]{index=2}
    res.status(204).end();

    // 5 分超の時刻ズレ検査（推奨）
    let tsNote: string | undefined;
    const MAX_SKEW_MS = 5 * 60 * 1000;
    const now = Date.now();
    const tsNum = Number(tsHeader);
    if (!Number.isNaN(tsNum) && Math.abs(now - tsNum) > MAX_SKEW_MS) {
      tsNote = "stale_timestamp(>5min)";
    }

    // 解析用ログ
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      parsed = null;
    }

    const sample = calc.slice(0, 6).map((c) => c.sig.slice(0, 12)); // 取り回しやすく短縮
    const matched = hit ? hit.uri : undefined;

    lastEvent.at = new Date().toISOString();
    lastEvent.path = withQuery;
    lastEvent.verified = verified;
    lastEvent.note = verified ? "hubspot-event" : "invalid-signature";
    lastEvent.headers = {
      "x-hubspot-signature-version": verHeader || undefined,
      "x-hubspot-signature-v3": sigHeader || undefined,
      "x-hubspot-request-timestamp": tsHeader || undefined,
      "content-type": req.header("content-type") || undefined,
      "user-agent": req.header("user-agent") || undefined,
      "host": hostHdr || undefined,
      "proto": proto || undefined,
    };
    lastEvent.body = parsed;
    lastEvent.sig_debug = verified
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
        };

    log(`received uri=${withQuery} verified=${verified} note=${lastEvent.note}`);
    if (verified && Array.isArray(parsed)) {
      log(`accepted events: ${parsed.length}`);
    }
  }
);

// ---- Debug -----------------------------------------------------------------
app.get("/debug/last", (req, res) => {
  if (!requireBearer(req, res)) return;
  if (!lastEvent.at) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, last_event: lastEvent });
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
    `webhook-ready (HubSpot v3, rawBody=on, redirect=${HUBSPOT_REDIRECT_URI}, secret=${
      WEBHOOK_SECRET ? "present" : "MISSING"
    }, baseUrl=${PUBLIC_BASE_URL || "n/a"})`
  );
});
