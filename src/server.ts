// src/server.ts
import express from "express";
import path from "path";

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
import {
  rulesGet,
  rulesPut,
  statsToday as statsTodayBase,
} from "./routes/rules.js";

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
   public-admin への絶対パス
   - import.meta を使わず CWD ベースで解決
   - Render/Node の実行時 CWD はプロジェクトルートなので安全
   ========================= */
const PUBLIC_ADMIN_DIR = path.resolve(process.cwd(), "public-admin");

/* =========================
   認可（トークン）ミドルウェア
   - 環境変数 SGC_TOKENS に JSON で格納（例：{"default":"tok_edit_xxx","*":"tok_view_ro"}）
   - PUT だけ編集トークン必須（GET は誰でも）
   ========================= */
type AnyReq = any;

function tenantFrom(req: AnyReq): string {
  return (
    String(req.params?.id || req.query?.tenant || "default").trim() || "default"
  );
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
  const expected = tMap[tenant] || tMap["*"];
  if (!expected) return res.status(401).json({ ok: false, error: "no-token-config" });
  if (token !== expected) return res.status(401).json({ ok: false, error: "bad-token" });
  next();
}

/* 基本設定 */
const app = express();
app.set("x-powered-by", false);
app.set("trust proxy", true);

/* JSON パーサ（webhook 用に rawBody も保持） */
app.use(
  express.json({
    verify: (req: AnyReq, _res: AnyReq, buf: Buffer) => {
      (req as AnyReq).rawBody = Buffer.from(buf);
    },
  })
);

/* === CORS: 全パスを許可（/tenant/* /admin/* など含む） === */
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Authorization"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
  next();
});
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

/* ===== 管理ページ（1画面UI）を静的配信
   https://<host>/admin/console/ で public-admin/console.html を出す */
app.use("/admin/console", express.static(PUBLIC_ADMIN_DIR));

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
    xpUnitMs: CALL_XP_UNIT_MS,
    per5min: CALL_XP_PER_5MIN,
    perCall: CALL_XP_PER_CALL,
  });
});
app.get("/support", (_req, res) => res.type("text/plain").send("Support page"));

/* Webhooks（既存） */
app.post("/webhooks/hubspot", hubspotWebhook);
app.post("/webhooks/workflow", workflowWebhook);
app.post("/webhooks/zoom", zoomWebhook);
app.post("/webhooks/habitica", habiticaWebhook);

/* CSV（既存） */
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

/* Admin UI（既存） */
app.get("/admin/dashboard", dashboardHandler);
app.get("/admin/mapping", mappingHandler);

/* ルール（UI保存）— GET は誰でも、PUT は編集トークン必須 */
app.get("/tenant/:id/rules", rulesGet);
app.put(
  "/tenant/:id/rules",
  requireEditorToken,
  express.json({ limit: "1mb" }),
  rulesPut
);
app.get("/tenant/:id/stats/today", statsTodayBase);

/* ラベル（UI保存）— GET は誰でも、PUT は編集トークン必須 */
app.get("/tenant/:id/labels", labelsGet);
app.put(
  "/tenant/:id/labels",
  requireEditorToken,
  express.json({ limit: "1mb" }),
  labelsPut
);

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
