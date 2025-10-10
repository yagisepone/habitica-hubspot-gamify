// src/server.ts
import express from "express";
import path from "path"; // 静的配信で使う

import {
  PORT,
  DRY_RUN,
  CALL_TOTALIZE_5MIN,
  CALL_XP_PER_5MIN,
  CALL_XP_PER_CALL,
  CALL_XP_UNIT_MS,
  APPOINTMENT_VALUES,
  PUBLIC_BASE_URL,
} from "./lib/env.js";
import { log } from "./lib/utils.js";
import { HAB_MAP, NAME2MAIL } from "./lib/maps.js";

// ルールAPI（既存）
import { rulesGet, rulesPut, statsToday as statsTodayBase } from "./routes/rules.js";

// Webhook（既存）
import { hubspotWebhook } from "./features/hubspot.js";
import { workflowWebhook } from "./features/workflow.js";
import { zoomWebhook } from "./features/zoom.js";
import { habiticaWebhook } from "./features/habitica_daily.js";

// CSV（既存）
import { csvDetect, csvUpsert } from "./features/csv_handlers.js";

// Admin UI（既存）
import { dashboardHandler, mappingHandler } from "./routes/admin.js";

// 観測ラベル（既存）
import { labelsGet, labelsPut } from "./routes/labels.js";

/* =========================
   認可（トークン）ミドルウェア
   - 環境変数 SGC_TOKENS でテナントごとにキーを管理（JSON）
   - PUT だけ編集トークン必須にする
   ========================= */
type AnyReq = any; // 既存コードに合わせてシンプルに

function tenantFrom(req: AnyReq): string {
  return String(req.params?.id || req.query?.tenant || "default").trim() || "default";
}
function getTokenFromHeaders(req: AnyReq): string {
  const raw = req.get("authorization") || req.get("x-authorization") || "";
  return raw.replace(/^Bearer\s+/i, "").trim();
}
function readTokenMap(): Record<string, string> {
  try {
    return JSON.parse(process.env.SGC_TOKENS || "{}");
  } catch {
    return {};
  }
}
function requireEditorToken(req: AnyReq, res: AnyReq, next: AnyReq) {
  const tMap = readTokenMap();
  const tenant = tenantFrom(req);
  const token = getTokenFromHeaders(req);
  const expected = tMap[tenant] || tMap["*"]; // テナントが無ければ * をフォールバック
  if (!expected) return res.status(401).json({ ok: false, error: "no-token-config" });
  if (token !== expected) return res.status(401).json({ ok: false, error: "bad-token" });
  next();
}
// （必要なら）GET もトークンで守りたい時用。今は使わない。
// function requireViewerToken(req: AnyReq, res: AnyReq, next: AnyReq) {
//   const tMap = readTokenMap();
//   const tenant = tenantFrom(req);
//   const token = getTokenFromHeaders(req);
//   const viewer = tMap["*"]; // 閲覧は * を参照（運用に合わせて変更可）
//   if (!viewer) return res.status(401).json({ ok: false, error: "no-viewer-token" });
//   if (token !== viewer) return res.status(401).json({ ok: false, error: "bad-token" });
//   next();
// }

/* 基本設定 */
const app = express();
app.set("x-powered-by", false);
app.set("trust proxy", true);

// JSONパーサ
app.use(
  express.json({
    verify: (req: any, _res: any, buf: Buffer) => {
      (req as any).rawBody = Buffer.from(buf);
    },
  })
);

// === CORS: すべてのパスで許可（特に /tenant/* /admin/*） ===
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Authorization"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

/* ===== 追加：管理ページ（1画面UI）を静的配信 =====
   public-admin/console.html / console.js を置くと
   https://<host>/admin/console/ で誰でも開ける */
app.use(
  "/admin/console",
  express.static(path.join(__dirname, "..", "public-admin"))
);

/* Health / Support */
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    version: "2025-10-10-ui-labels-v3",
    tz: process.env.TZ || "Asia/Tokyo",
    now: new Date().toISOString(),
    baseUrl: PUBLIC_BASE_URL || null,
    dryRun: DRY_RUN,
    habiticaUserCount: Object.keys(HAB_MAP).length,
    nameMapCount: Object.keys(NAME2MAIL).length,
    apptValues: APPOINTMENT_VALUES,
    totalize: CALL_TOTALIZE_5MIN,
  });
});
app.get("/support", (_req, res) => res.type("text/plain").send("Support page"));

// Webhooks（既存）
app.post("/webhooks/hubspot", hubspotWebhook);
app.post("/webhooks/workflow", workflowWebhook);
app.post("/webhooks/zoom", zoomWebhook);
app.post("/webhooks/habitica", habiticaWebhook);

// CSV（既存）
app.post(
  "/admin/csv/detect",
  express.text({ type: "text/csv", limit: "20mb" }),
  csvDetect
);
app.post(
  "/admin/csv",
  express.text({ type: "text/csv", limit: "20mb" }),
  csvUpsert
);

// Admin UI（既存）
app.get("/admin/dashboard", dashboardHandler);
app.get("/admin/mapping", mappingHandler);

// ルール（UI保存）— GETは誰でも、PUTは編集トークン必須
app.get("/tenant/:id/rules", rulesGet);
app.put("/tenant/:id/rules", requireEditorToken, express.json({ limit: "1mb" }), rulesPut);
app.get("/tenant/:id/stats/today", statsTodayBase); // 既存

// ラベル（UI保存）— GETは誰でも、PUTは編集トークン必須
app.get("/tenant/:id/labels", labelsGet);
app.put("/tenant/:id/labels", requireEditorToken, express.json({ limit: "1mb" }), labelsPut);

/* Start */
app.listen(PORT, () => {
  log(
    `listening :${PORT} DRY_RUN=${DRY_RUN} totalize=${CALL_TOTALIZE_5MIN} unit=${CALL_XP_UNIT_MS}ms per5min=${CALL_XP_PER_5MIN} perCall=${CALL_XP_PER_CALL}`
  );
  log(
    `[habitica] users=${Object.keys(HAB_MAP).length}, [name->email] entries=${Object.keys(NAME2MAIL).length}`
  );
});
export {};
