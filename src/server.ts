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
import { trophiesGet, trophiesPut, trophiesRun } from "./routes/trophies.js";

// Webhook（既存）
import { hubspotWebhook } from "./features/hubspot.js";
import { workflowWebhook } from "./features/workflow.js";
import { zoomWebhook } from "./features/zoom.js";
import { habiticaWebhook } from "./features/habitica_daily.js";

// CSV（既存）
import { csvDetect, csvUpsert } from "./features/csv_handlers.js";

// Admin UI（既存）
import { dashboardHandler, mappingHandler } from "./routes/admin.js";
import { partyPutConfig, partyGetSuggest, partyHabiticaSync } from "./routes/party.js";

// 観測ラベル（既存）
import { labelsGet, labelsPut } from "./routes/labels.js";
import { opsApiRouter, opsRouter } from "./routes/ops.js";

/* =========================
   認可（トークン）ミドルウェア
   - 環境変数 SGC_TOKENS に JSON でテナント→編集トークン を入れる
     例: {"ワビサビ株式会社":"wabisabi-habitica-hubspot-connection", "*":"wabisabi-habitica-hubspot-connection"}
   - PUT のみトークン必須（GETは公開のまま）
   ========================= */

/* ===== 静的UIの場所を自動検出 =====
   - prod: dist/public-admin/console.html
   - dev : src/public-admin/console.html
   どちらか存在する方を使う。import.meta は使わないので赤線も消えます。
*/
function resolvePublicAdminDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "dist", "public-admin"),
    path.resolve(process.cwd(), "src", "public-admin"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "console.html"))) return dir;
  }
  // 見つからなくても一番目を返す（あとで 404 になったらログを見る）
  return candidates[0];
}
const PUBLIC_ADMIN_DIR = resolvePublicAdminDir();

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

function corsHeaders(
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
}
const setStaticHeaders = (res: any, _path?: string, _stat?: any) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
};

const PUB_DIST = path.resolve(__dirname, "../public-admin");
const PUB_ROOT = path.resolve(process.cwd(), "public-admin");
const PUB_SRC = path.resolve(process.cwd(), "src/public-admin");

if (fs.existsSync(PUB_DIST)) {
  app.use(
    "/public-admin",
    corsHeaders,
    express.static(PUB_DIST, { setHeaders: setStaticHeaders })
  );
}
if (fs.existsSync(PUB_ROOT)) {
  app.use(
    "/public-admin",
    corsHeaders,
    express.static(PUB_ROOT, { setHeaders: setStaticHeaders })
  );
}

app.get("/public-admin/injector.js", corsHeaders, (_req, res) => {
  const candidates = [
    path.join(PUB_DIST, "injector.js"),
    path.join(PUB_ROOT, "injector.js"),
    path.join(PUB_SRC, "injector.js"),
  ];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) {
    return res.status(404).type("text/plain").send("injector.js not found");
  }
  res.type("application/javascript");
  res.sendFile(file);
});

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
app.use("/admin/console", express.static(PUBLIC_ADMIN_DIR, { index: "console.html", extensions: ["html"] }));
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

/* トロフィー（称号） */
app.get("/tenant/:id/trophies", trophiesGet);
app.put("/tenant/:id/trophies", express.json({ limit: "1mb" }), trophiesPut);
app.post("/tenant/:id/trophies/run", trophiesRun);

/* パーティ自動化 */
app.put("/tenant/:id/party/config", express.json({ limit: "1mb" }), partyPutConfig);
app.get("/tenant/:id/party/suggest", partyGetSuggest);
app.post("/tenant/:id/party/habitica-sync", partyHabiticaSync);

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
