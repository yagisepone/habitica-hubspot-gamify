// src/server.ts
import express from "express";
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

// ルールAPIを読み込む（他は触らない）
import { rulesGet, rulesPut, statsToday } from "./routes/rules.js";

/* 基本設定 */
const app = express();
app.set("x-powered-by", false);
app.set("trust proxy", true);
app.use(
  express.json({
    verify: (req: any, _res: any, buf: Buffer) => {
      (req as any).rawBody = Buffer.from(buf);
    },
  })
);

// ===== CORS（管理・テナント・健診を許可）=====
// fetch 版でもプリフライトを通すため、PUT と /tenant/*, /healthz を追加
app.use((req, res, next) => {
  if (
    req.path.startsWith("/admin/") ||
    req.path.startsWith("/tenant/") ||
    req.path === "/healthz"
  ) {
    // 必要に応じて Origin を厳格化（* のままでもOK）
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, X-Authorization"
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") return res.status(204).end();
  }
  next();
});

/* Health / Support */
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    version: "2025-09-29-spec-v1.4",
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

/* Webhook routes */
import { hubspotWebhook } from "./features/hubspot.js";
import { workflowWebhook } from "./features/workflow.js";
import { zoomWebhook } from "./features/zoom.js";
import { habiticaWebhook } from "./features/habitica_daily.js";

app.post("/webhooks/hubspot", hubspotWebhook);
app.post("/webhooks/workflow", workflowWebhook);
app.post("/webhooks/zoom", zoomWebhook);
app.post("/webhooks/habitica", habiticaWebhook);

/* CSV routes */
import { csvDetect, csvUpsert } from "./features/csv_handlers.js";
app.post("/admin/csv/detect", express.text({ type: "text/csv", limit: "20mb" }), csvDetect);
app.post("/admin/csv",        express.text({ type: "text/csv", limit: "20mb" }), csvUpsert);

/* Admin UI */
import { dashboardHandler, mappingHandler } from "./routes/admin.js";
app.get("/admin/dashboard", dashboardHandler);
app.get("/admin/mapping",   mappingHandler);

// 新規API（既存ルートとは独立）
app.get("/tenant/:id/rules", rulesGet);
app.put("/tenant/:id/rules", express.json({ limit: "1mb" }), rulesPut);
app.get("/tenant/:id/stats/today", statsToday);

/* Start server */
app.listen(PORT, () => {
  log(
    `listening :${PORT} DRY_RUN=${DRY_RUN} totalize=${CALL_TOTALIZE_5MIN} unit=${CALL_XP_UNIT_MS}ms per5min=${CALL_XP_PER_5MIN} perCall=${CALL_XP_PER_CALL}`
  );
  log(`[habitica] users=${Object.keys(HAB_MAP).length}, [name->email] entries=${Object.keys(NAME2MAIL).length}`);
  log(`[env] APPOINTMENT_VALUES=${JSON.stringify(APPOINTMENT_VALUES)}`);
});
export {};
