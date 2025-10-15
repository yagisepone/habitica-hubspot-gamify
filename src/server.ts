// src/server.ts
import express from "express";
import path from "path";
import fs from "fs";

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
import { requireEditorToken } from "./lib/auth.js";

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
import { opsApiRouter, opsRouter } from "./routes/ops.js";

/* =========================
   認可（トークン）ミドルウェア
   - 環境変数 SGC_TOKENS に JSON でテナント→編集トークン を入れる
     例: {"ワビサビ株式会社":"wabisabi-habitica-hubspot-connection", "*":"wabisabi-habitica-hubspot-connection"}
   - PUT のみトークン必須（GETは公開のまま）
   ========================= */

const PUBLIC_ADMIN_DIR = path.join(__dirname, "public-admin");
const PUBLIC_DIR = path.join(__dirname, "public");

/* 基本設定 */
const app = express();
app.set("x-powered-by", false);
app.set("trust proxy", true);

// JSONパーサ（rawBody保持）
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
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

/* ===== 管理ページ（1画面UI）を静的配信 =====
   https://<host>/admin/console/ で console.html を返す
*/
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://habitica.com");
  res.setHeader("Vary", "Origin");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});

app.use(
  express.static(PUBLIC_DIR, {
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=60");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    },
  })
);

app.get("/t/:tenant", (req, res) => {
  res.redirect(302, `/i.js?tenant=${encodeURIComponent(req.params.tenant)}`);
});

app.use(
  "/admin/console",
  express.static(PUBLIC_ADMIN_DIR, {
    index: "console.html",
    extensions: ["html"],
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=300");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    },
  })
);
app.get("/admin/console/*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_ADMIN_DIR, "console.html"));
});

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
    publicAdminDirExists: fs.existsSync(path.join(PUBLIC_ADMIN_DIR, "console.html")),
    publicAdminDir: PUBLIC_ADMIN_DIR,
  });
});
app.get("/support", (_req, res) => res.type("text/plain").send("Support page"));

/* Webhooks（既存） */
app.post("/webhooks/hubspot", hubspotWebhook);
app.post("/webhooks/workflow", workflowWebhook);
app.post("/webhooks/zoom", zoomWebhook);
app.post("/webhooks/habitica", habiticaWebhook);

/* CSV（既存） */
app.post("/admin/csv/detect", express.text({ type: "text/csv", limit: "20mb" }), csvDetect);
app.post("/admin/csv", express.text({ type: "text/csv", limit: "20mb" }), csvUpsert);

/* Admin UI（既存） */
app.get("/admin/dashboard", dashboardHandler);
app.get("/admin/mapping", mappingHandler);

/* Operations API（新規） */
app.use("/tenant", opsRouter);
app.use("/ops", opsApiRouter);

/* ルール（UI保存）— GETは誰でも、PUTは編集トークン必須 */
app.get("/tenant/:id/rules", rulesGet);
app.put("/tenant/:id/rules", requireEditorToken, express.json({ limit: "1mb" }), rulesPut);
app.get("/tenant/:id/stats/today", statsTodayBase);

/* ラベル（UI保存）— GETは誰でも、PUTは編集トークン必須 */
app.get("/tenant/:id/labels", labelsGet);
app.put("/tenant/:id/labels", requireEditorToken, express.json({ limit: "1mb" }), labelsPut);

/* Start */
app.listen(PORT, () => {
  log(
    `listening :${PORT} DRY_RUN=${DRY_RUN} totalize=${CALL_TOTALIZE_5MIN} unit=${CALL_XP_UNIT_MS}ms per5min=${CALL_XP_PER_5MIN} perCall=${CALL_XP_PER_CALL}`
  );
  log(`[habitica] users=${Object.keys(HAB_MAP).length}, [name->email] entries=${Object.keys(NAME2MAIL).length}`);
  log(`[admin] console at /admin/console/ from ${PUBLIC_ADMIN_DIR}`);
});
export {};
