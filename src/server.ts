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

// 観測ラベル（本件）
import { labelsGet, labelsPut } from "./routes/labels.js";

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

// ===== CORS：/admin/*, /tenant/*, /healthz を許可 =====
app.use((req, res, next) => {
  if (
    req.path.startsWith("/admin/") ||
    req.path.startsWith("/tenant/") ||
    req.path === "/healthz"
  ) {
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
    version: "2025-10-09-ui-labels-v2",
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

// Webhooks
app.post("/webhooks/hubspot", hubspotWebhook);
app.post("/webhooks/workflow", workflowWebhook);
app.post("/webhooks/zoom", zoomWebhook);
app.post("/webhooks/habitica", habiticaWebhook);

// CSV
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

// Admin UI
app.get("/admin/dashboard", dashboardHandler);
app.get("/admin/mapping", mappingHandler);

// ルール
app.get("/tenant/:id/rules", rulesGet);
app.put("/tenant/:id/rules", express.json({ limit: "1mb" }), rulesPut);
app.get("/tenant/:id/stats/today", statsTodayBase);

// ラベル（本件）
app.get("/tenant/:id/labels", labelsGet);
app.put("/tenant/:id/labels", express.json({ limit: "1mb" }), labelsPut);

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
