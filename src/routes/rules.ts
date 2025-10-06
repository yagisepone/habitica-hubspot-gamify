// src/routes/rules.ts
import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import {
  AUTH_TOKEN,
  CALL_XP_PER_CALL,
  CALL_XP_PER_5MIN,
  CALL_XP_UNIT_MS,
  APPOINTMENT_XP,
  SALES_XP_STEP_YEN,
  SALES_XP_PER_STEP,
} from "../lib/env.js";
import { isoDay, readJsonlAll } from "../lib/utils.js";

/** 既定ルール（現行の環境変数を既定値として採用） */
function defaultRules() {
  return {
    xp: {
      call: { perCall: CALL_XP_PER_CALL },
      minutes: [{ everyMin: Math.round(CALL_XP_UNIT_MS / 60000), xp: CALL_XP_PER_5MIN, repeat: true }],
      appointment: APPOINTMENT_XP,
      approval: 30,
      revenue: [{ per: SALES_XP_STEP_YEN, xp: SALES_XP_PER_STEP }],
    },
    badges: { makerAward: { enabled: true, cycle: "monthly", topN: 1 } },
    limits: { dailyXpCap: 1000 },
  };
}

const TENANT_DIR = path.join(process.cwd(), "data", "tenants");
const ensureDir = (t: string) => fs.mkdirSync(path.join(TENANT_DIR, t), { recursive: true });
const rulesFile = (t: string) => path.join(TENANT_DIR, t, "rules.json");

/** Bearer認証（既存 AUTH_TOKEN を流用） */
function requireBearer(req: Request, res: Response): boolean {
  const tok = (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!AUTH_TOKEN) { res.status(500).json({ ok: false, error: "missing AUTH_TOKEN" }); return false; }
  if (tok !== AUTH_TOKEN) { res.status(401).json({ ok: false, error: "auth" }); return false; }
  return true;
}

/** GET /tenant/:id/rules … 保存済みがあれば返し、無ければ既定値を返す */
export function rulesGet(req: Request, res: Response) {
  if (!requireBearer(req, res)) return;
  const tenant = String(req.params.id || "default");
  const fp = rulesFile(tenant);
  if (fs.existsSync(fp)) {
    const json = JSON.parse(fs.readFileSync(fp, "utf8") || "{}");
    res.json(json);
  } else {
    res.json(defaultRules());
  }
}

/** PUT /tenant/:id/rules … ルールの保存（既存機能には未適用＝挙動は変えない） */
export function rulesPut(req: Request, res: Response) {
  if (!requireBearer(req, res)) return;
  const tenant = String(req.params.id || "default");
  ensureDir(tenant);
  fs.writeFileSync(rulesFile(tenant), JSON.stringify(req.body ?? {}, null, 2));
  res.json({ ok: true });
}

/** （オプション）HUD用 当日サマリ：GET /tenant/:id/stats/today
 *  既存のevents JSONLから集計するだけ。既存機能に影響なし。
 */
export function statsToday(req: Request, res: Response) {
  if (!requireBearer(req, res)) return;
  const tenant = String(req.params.id || "default");
  const today = isoDay();

  const calls = readJsonlAll("data/events/calls.jsonl").filter((x: any) => x.day === today);
  const appts = readJsonlAll("data/events/appointments.jsonl").filter((x: any) => x.day === today);
  const apprs = readJsonlAll("data/events/approvals.jsonl").filter((x: any) => x.day === today);
  const sales = readJsonlAll("data/events/sales.jsonl").filter((x: any) => x.day === today);

  const minutes = Math.round(calls.reduce((s: number, c: any) => s + (c.ms || 0) / 60000, 0));
  const revenue = sales.reduce((s: number, r: any) => s + Number(r.amount || 0), 0);

  // 目標値は保存ルール or 既定ルールから取る（見た目用）
  let rules = defaultRules();
  const fp = rulesFile(tenant);
  if (fs.existsSync(fp)) rules = JSON.parse(fs.readFileSync(fp, "utf8") || "{}");
  const target = rules?.limits?.dailyXpCap ?? 1000;

  // “現在XP”は可視化用の概算（既存の付与ロジックには影響なし）
  const xpFromCalls = (rules?.xp?.call?.perCall || 0) * calls.length;
  const everyMin = rules?.xp?.minutes?.[0]?.everyMin || 5;
  const perMinXp = rules?.xp?.minutes?.[0]?.xp || 0;
  const xpFromMinutes = Math.floor(minutes / everyMin) * perMinXp;
  const xpFromAppt = (rules?.xp?.appointment || 0) * appts.length;
  const xpFromApproval = (rules?.xp?.approval || 0) * apprs.length;
  const step = rules?.xp?.revenue?.[0]?.per || 100000;
  const stepXp = rules?.xp?.revenue?.[0]?.xp || 50;
  const xpFromRevenue = Math.floor(revenue / step) * stepXp;

  res.json({
    xp: { current: xpFromCalls + xpFromMinutes + xpFromAppt + xpFromApproval + xpFromRevenue, target },
    calls: calls.length,
    minutes,
    appointments: appts.length,
    approvals: apprs.length,
    revenue,
  });
}
