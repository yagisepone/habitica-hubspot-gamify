// src/web/server.ts
import "dotenv/config";
import fs from "fs";
import path from "path";
import express, { Request, Response, NextFunction } from "express";
import { rawBodySaver, requireZoomSignature } from "./server/zoomAuth";
import { registerWebhooks } from "../handlers/webhooks"; // ← HubSpot v3 受け口

// ──────────────────────────────────────────────────────────────
// 基本設定
// ──────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3000);
const TZ = process.env.TZ || "Asia/Tokyo";

// 基本認証（UI保護用）
const BASIC_USER = process.env.BASIC_USER || "";
const BASIC_PASS = process.env.BASIC_PASS || "";

// データ置き場（イベント保存など）
const DATA_DIR = path.join(process.cwd(), "data");
const EVENTS_DIR = path.join(DATA_DIR, "events");
fs.mkdirSync(EVENTS_DIR, { recursive: true });

// ──────────────────────────────────────────────────────────────
// アプリ初期化
// ──────────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", true);

// ★ HubSpot v3 署名で必要な「生文字列」を保持しつつ JSON パース
//   zoomAuth の rawBodySaver は (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } を想定
app.use(express.json({ verify: rawBodySaver }));

// 簡易アクセスログ（必要に応じて morgan/pino に置換可）
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} from ${req.ip}`);
  next();
});

// ──────────────────────────────────────────────────────────────
// 公開エンドポイント（BASIC不要）
// ──────────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) =>
  res.status(200).json({ ok: true, tz: TZ, now: new Date().toISOString() })
);

app.get("/legal/privacy", (_req, res) => {
  res.status(200).type("text/plain").send("Privacy Policy (placeholder).");
});
app.get("/legal/terms", (_req, res) => {
  res.status(200).type("text/plain").send("Terms of Service (placeholder).");
});
app.get("/support", (_req, res) => {
  res.status(200).type("text/plain").send("Support page (placeholder).");
});

// ──────────────────────────────────────────────────────────────
// BASIC認証（UIのみ保護）
//   - /webhooks/*, /healthz, /legal/*, /support は除外
// ──────────────────────────────────────────────────────────────
function uiBasicGuard(req: Request, res: Response, next: NextFunction) {
  const open = [/^\/webhooks\//, /^\/healthz$/, /^\/legal\/(privacy|terms)$/, /^\/support$/].some((r) =>
    r.test(req.path)
  );
  if (open) return next();

  if (!BASIC_USER || !BASIC_PASS) return next(); // 認証未設定なら素通り（運用では設定推奨）

  const h = String(req.headers.authorization || "");
  if (!h.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Restricted"');
    return res.status(401).send("Authentication required.");
  }
  const [, base64] = h.split(" ");
  const decoded = Buffer.from(base64, "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);

  if (user === BASIC_USER && pass === BASIC_PASS) return next();

  res.setHeader("WWW-Authenticate", 'Basic realm="Restricted"');
  return res.status(401).send("Unauthorized");
}
app.use(uiBasicGuard);

// ──────────────────────────────────────────────────────────────
// Webhooks（BASIC不要）
// ──────────────────────────────────────────────────────────────

// ✅ HubSpot Webhook v3（Developer App / Client secret & Private App / signing secret 両対応）
//   実体は ../handlers/webhooks.ts の handleHubSpotWebhook に実装。
//   署名計算は (method + uri + body + timestamp) を HMAC-SHA256(secret)→Base64。
//   secret は HUBSPOT_WEBHOOK_SIGNING_SECRET が無ければ HUBSPOT_CLIENT_SECRET を使用。
registerWebhooks(app);
console.log("[web] webhook-ready (HubSpot v3, rawBody on)");

// ✅ Zoom Webhook（既存：署名必須）
app.post("/webhooks/zoom", requireZoomSignature, (req: Request, res: Response) => {
  try {
    const line = JSON.stringify({ received_at: new Date().toISOString(), ...req.body }) + "\n";
    fs.appendFileSync(path.join(EVENTS_DIR, "zoom_calls.jsonl"), line);
  } catch (e) {
    console.error("Failed to write event:", e);
  }
  return res.status(200).json({ ok: true });
});

// ──────────────────────────────────────────────────────────────
// UIルート（ダッシュボード等）
// ──────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res
    .status(200)
    .type("text/html")
    .send(`<!doctype html>
<html lang="ja"><meta charset="utf-8">
<title>Gamify Dashboard</title>
<body style="font-family:system-ui;padding:24px">
  <h1>Gamify Dashboard</h1>
  <p>Server time: ${new Date().toLocaleString("ja-JP", { timeZone: TZ })}</p>
  <ul>
    <li><a href="/healthz">/healthz</a></li>
    <li><a href="/support">/support</a></li>
    <li><a href="/legal/privacy">/legal/privacy</a></li>
    <li><a href="/legal/terms">/legal/terms</a></li>
  </ul>
</body></html>`);
});

// ──────────────────────────────────────────────────────────────
// 404 / エラーハンドラ
// ──────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "not_found" }));
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "internal_error" });
});

// ──────────────────────────────────────────────────────────────
// 起動
// ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 gamify-web listening on :${PORT} (TZ=${TZ})`);
});
