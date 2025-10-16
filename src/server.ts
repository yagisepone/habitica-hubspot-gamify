// src/server.ts
import express from "express";
import cors from "cors";
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
import { dashboardHandler, mappingHandler, consoleHandler } from "./routes/admin.js";

// 観測ラベル（既存）
import { labelsGet, labelsPut } from "./routes/labels.js";
import { opsApiRouter, opsRouter } from "./routes/ops.js";
import { tenantOpsRouter } from "./routes/tenantOps.js";

/* ===========================================
   PATHS
   =========================================== */
const ADMIN_STATIC_DIR = path.join(__dirname, "public-admin");
const PUBLIC_DIR = path.join(__dirname, "public");

/* ===========================================
   APP BASICS
   =========================================== */
const app = express();
app.set("x-powered-by", false);
app.set("trust proxy", true);

app.use(
  cors({
    origin: [/^https?:\/\/([^/]+\.)?habitica\.com$/],
    credentials: false,
  })
);

/* ===========================================
   BODY PARSER (keep raw body for webhook signature)
   =========================================== */
app.use(
  express.json({
    verify: (req: any, _res: any, buf: Buffer) => {
      (req as any).rawBody = Buffer.from(buf);
    },
  })
);

/* ===========================================
   CORS
   - 一般APIはワイルドカードで緩く
   - admin/console は iframe 埋め込み制御を CSP で行うため Origin 固定
   =========================================== */
app.use((req, res, next) => {
  // デフォルト: API を広く許可
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

/* ===========================================
   iframe 埋め込みを許可（/admin/console 配下）
   - Habitica からの iframe を許可
   - X-Frame-Options を無効化
   - Cross-Origin-Isolation を緩和
   - CORP は cross-origin に
   =========================================== */
app.use((req, res, next) => {
  if (req.path.startsWith("/admin/console")) {
    // Habitica ドメインからの埋め込みを許可
    res.setHeader(
      "Content-Security-Policy",
      "frame-ancestors 'self' https://habitica.com https://*.habitica.com"
    );
    // XFO は外す（helmet 等で付与されていても上書き）
    res.removeHeader("X-Frame-Options");

    // iframe 内で過度に分離されないように
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");

    // Habitica からの静的取得を許容（念のため）
    res.setHeader("Access-Control-Allow-Origin", "https://habitica.com");
    res.setHeader("Vary", "Origin");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  }
  next();
});

/* ===========================================
   STATIC FILES
   =========================================== */

// /public （画像・アイコン 等）
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=60");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    },
  })
);

// /admin/console （UI 一式）
app.get("/admin/console", consoleHandler);
app.use(
  "/admin/console",
  express.static(ADMIN_STATIC_DIR, {
    index: "console.html",
    extensions: ["html", "js", "css"],
    setHeaders(res, filePath) {
      // JS/CSS は短めキャッシュ、HTML はほぼno-cache
      if (filePath.endsWith(".js") || filePath.endsWith(".css")) {
        res.setHeader("Cache-Control", "public, max-age=300");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    },
  })
);

// 直リンクで末尾がスラッシュでないパスも console.html にフォールバック
app.get("/admin/console/*", (_req, res) => {
  res.sendFile(path.join(ADMIN_STATIC_DIR, "console.html"));
});

// 互換: 旧エントリポイント（/admin/console/i.js, /i.js）
app.get("/admin/console/i.js", (_req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(ADMIN_STATIC_DIR, "i.js"));
});
app.get("/i.js", (_req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(ADMIN_STATIC_DIR, "i.js"));
});

// ブックマークレットが直接読む injector（明示のエンドポイントを用意）
app.get("/admin/console/injector.js", (_req, res) => {
  res.type("application/javascript");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.sendFile(path.join(ADMIN_STATIC_DIR, "injector.js"));
});

// 互換: /t/:tenant → i.js?tenant=...
app.get("/t/:tenant", (req, res) => {
  res.redirect(302, `/i.js?tenant=${encodeURIComponent(req.params.tenant)}`);
});

/* ===========================================
   HEALTH / SUPPORT
   =========================================== */
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
    publicAdminDirExists: fs.existsSync(path.join(ADMIN_STATIC_DIR, "console.html")),
    publicAdminDir: ADMIN_STATIC_DIR,
  });
});
app.get("/support", (_req, res) => res.type("text/plain").send("Support page"));

/* ===========================================
   WEBHOOKS
   =========================================== */
app.post("/webhooks/hubspot", hubspotWebhook);
app.post("/webhooks/workflow", workflowWebhook);
app.post("/webhooks/zoom", zoomWebhook);
app.post("/webhooks/habitica", habiticaWebhook);

/* ===========================================
   CSV
   =========================================== */
app.post("/admin/csv/detect", express.text({ type: "text/csv", limit: "20mb" }), csvDetect);
app.post("/admin/csv",       express.text({ type: "text/csv", limit: "20mb" }), csvUpsert);

/* ===========================================
   ADMIN UI API
   =========================================== */
app.get("/admin/dashboard", dashboardHandler);
app.get("/admin/mapping",  mappingHandler);

/* ===========================================
   OPS / TENANT API
   =========================================== */
app.use("/tenant/:id/ops", tenantOpsRouter);
app.use("/tenant", opsRouter);
app.use("/ops",    opsApiRouter);

/* ===========================================
   RULES / LABELS
   - GET は公開
   - PUT は編集トークン必須
   =========================================== */
app.get("/tenant/:id/rules",  rulesGet);
app.put("/tenant/:id/rules",  requireEditorToken, express.json({ limit: "1mb" }), rulesPut);
app.get("/tenant/:id/stats/today", statsTodayBase);

app.get("/tenant/:id/labels", labelsGet);
app.put("/tenant/:id/labels", requireEditorToken, express.json({ limit: "1mb" }), labelsPut);

/* ===========================================
   START
   =========================================== */
app.listen(PORT, () => {
  log(
    `listening :${PORT} DRY_RUN=${DRY_RUN} totalize=${CALL_TOTALIZE_5MIN} unit=${CALL_XP_UNIT_MS}ms per5min=${CALL_XP_PER_5MIN} perCall=${CALL_XP_PER_CALL}`
  );
  log(`[habitica] users=${Object.keys(HAB_MAP).length}, [name->email] entries=${Object.keys(NAME2MAIL).length}`);
  log(`[admin] console at /admin/console/ from ${ADMIN_STATIC_DIR}`);
});

export {};
