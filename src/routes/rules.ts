// src/routes/rules.ts
import type { Request, Response } from "express";
import path from "path";
import { promises as fs } from "fs";
import {
  CALL_XP_PER_CALL,
  CALL_XP_UNIT_MS,
  CALL_XP_PER_5MIN,
  APPOINTMENT_XP,
} from "../lib/env.js";
import { log } from "../lib/utils.js";

type Rules = {
  xp: {
    call: { perCall: number };
    minutes: {
      unitMs: number;
      perUnitMs?: number;
      per5min?: number;
      list?: Array<{ min: number; xp: number }>;
    };
    appointment: { xp: number; badge?: string };
  };
  approval: { enabled: boolean; xp: number; badge: string };
  sales: { milestones: Array<{ amount: number; xp: number; badge?: string }> };
};

const RULES_DIR = path.resolve("data/rules");
const safeTenant = (t: string | undefined) =>
  String(t || "default").trim() || "default";

function defaults(): Rules {
  return {
    xp: {
      call: { perCall: Number(CALL_XP_PER_CALL ?? 1) || 0 },
      minutes: {
        unitMs: Number(CALL_XP_UNIT_MS ?? 300000) || 300000,
        perUnitMs: Number(CALL_XP_PER_5MIN ?? 2) || 0,
        per5min: Number(CALL_XP_PER_5MIN ?? 2) || 0,
        list: [{ min: 5, xp: Number(CALL_XP_PER_5MIN ?? 2) || 0 }],
      },
      appointment: { xp: Number(APPOINTMENT_XP ?? 20) || 0, badge: "🏅新規アポ獲得" },
    },
    approval: { enabled: true, xp: 0, badge: "承認" },
    sales: { milestones: [] },
  };
}

async function ensureDir() {
  await fs.mkdir(RULES_DIR, { recursive: true }).catch(() => {});
}

async function readRulesFile(tenant: string): Promise<Rules> {
  await ensureDir();
  const file = path.resolve(RULES_DIR, `${safeTenant(tenant)}.json`);
  try {
    const txt = await fs.readFile(file, "utf8");
    const j = JSON.parse(txt || "{}");
    return normalizeRules(j);
  } catch {
    return defaults();
  }
}
async function writeRulesFile(tenant: string, body: any): Promise<Rules> {
  await ensureDir();
  const file = path.resolve(RULES_DIR, `${safeTenant(tenant)}.json`);
  const out = normalizeRules(body || {});
  await fs.writeFile(file, JSON.stringify(out, null, 2));
  return out;
}

// 最低限の正規化
function normalizeRules(b: any): Rules {
  const d = defaults();
  const r: Rules = d;

  // コール
  r.xp.call.perCall = Math.max(0, Number(b?.xp?.call?.perCall ?? r.xp.call.perCall) || 0);

  // 通話
  const list = Array.isArray(b?.xp?.minutes?.list)
    ? b.xp.minutes.list
    : [{ min: Math.max(1, Math.floor((b?.xp?.minutes?.unitMs ?? r.xp.minutes.unitMs) / 60000)), xp: Number(b?.xp?.minutes?.perUnitMs ?? r.xp.minutes.perUnitMs) || 0 }];

  const head = list[0] || { min: 5, xp: 0 };
  r.xp.minutes.unitMs = Math.max(60000, Number(head.min) * 60000);
  r.xp.minutes.perUnitMs = Math.max(0, Number(head.xp) || 0);
  r.xp.minutes.per5min =
    head.min === 5 ? r.xp.minutes.perUnitMs : undefined;
  r.xp.minutes.list = list.map((it: any) => ({
    min: Math.max(1, Number(it?.min) || 1),
    xp: Math.max(0, Number(it?.xp) || 0),
  }));

  // 既定アポ
  r.xp.appointment.xp = Math.max(
    0,
    Number(b?.xp?.appointment?.xp ?? r.xp.appointment.xp) || 0
  );
  r.xp.appointment.badge = String(
    (b?.xp?.appointment?.badge ?? r.xp.appointment.badge) || ""
  );

  // 承認
  r.approval.enabled = !!(b?.approval?.enabled ?? r.approval.enabled);
  r.approval.xp = Math.max(0, Number(b?.approval?.xp ?? r.approval.xp) || 0);
  r.approval.badge = String(
    (b?.approval?.badge ?? r.approval.badge) || "承認"
  );

  // 売上マイルストン
  const ms = Array.isArray(b?.sales?.milestones)
    ? b.sales.milestones
    : r.sales.milestones;
  r.sales.milestones = ms.map((m: any) => ({
    amount: Math.max(0, Number(m?.amount) || 0),
    xp: Math.max(0, Number(m?.xp) || 0),
    badge: m?.badge ? String(m.badge) : undefined,
  }));

  return r;
}

/** === HTTPハンドラ === */
export async function rulesGet(req: Request, res: Response) {
  const tenant = safeTenant(req.params.id);
  const data = await readRulesFile(tenant);
  res.json(data);
}
export async function rulesPut(req: Request, res: Response) {
  const tenant = safeTenant(req.params.id);
  const body = req.body || {};
  const saved = await writeRulesFile(tenant, body);
  res.json(saved);
}

/** 既存の互換（UI保存には未使用。必要なら既存実装に差し替え可） */
export async function statsToday(_req: Request, res: Response) {
  res.json({ ok: true, items: [] });
}
