import { promises as fs } from "fs";
import path from "path";
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
  approval: { enabled: boolean; xp: number; badge?: string };
  sales: { milestones: Array<{ amount: number; xp: number; badge?: string }> };
};

const RULES_DIR = path.resolve("data/rules");

function safeTenant(input: string | undefined) {
  const v = String(input || "default").trim();
  return v.replace(/[^a-zA-Z0-9_.@\-]/g, "_");
}

function toInt(v: any, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
}

function defaults(): Rules {
  const unitMs = Number(CALL_XP_UNIT_MS || 300000);
  const per5 = Number(CALL_XP_PER_5MIN || 2);
  const unitMin = Math.max(1, Math.round(unitMs / 60000));

  // ここで env を“直接”読む（lib/env.js に未定義でもOK）
  const approvalBadge =
    process.env.APPROVAL_BADGE_LABEL || "承認";
  const appointmentBadge =
    process.env.APPOINTMENT_BADGE_LABEL || "新規アポ獲得";

  return {
    xp: {
      call: { perCall: Number(CALL_XP_PER_CALL || 1) },
      minutes: {
        unitMs,
        perUnitMs: per5,
        per5min: unitMin === 5 ? per5 : undefined,
        list: [{ min: unitMin, xp: per5 }],
      },
      appointment: {
        xp: Number(APPOINTMENT_XP || 20),
        badge: appointmentBadge,
      },
    },
    approval: {
      enabled: true,
      xp: 0,
      badge: approvalBadge,
    },
    sales: { milestones: [] },
  };
}

function deepMerge<T>(base: T, patch: any): T {
  if (patch == null || typeof patch !== "object") return base;
  const out: any = Array.isArray(base) ? [] : { ...(base as any) };
  if (Array.isArray(base)) {
    return (Array.isArray(patch) ? patch : base) as any;
  }
  for (const k of Object.keys(patch)) {
    const bv: any = (base as any)[k];
    const pv: any = patch[k];
    if (pv && typeof pv === "object" && !Array.isArray(pv)) {
      out[k] = deepMerge(bv ?? {}, pv);
    } else {
      out[k] = pv;
    }
  }
  return out;
}

function normalize(r: any): Rules {
  const d = defaults();
  const m = deepMerge(d, r || {}) as Rules;

  // number 正規化
  m.xp.call.perCall = toInt(m?.xp?.call?.perCall, d.xp.call.perCall);

  const unitMs = toInt(m?.xp?.minutes?.unitMs, d.xp.minutes.unitMs);
  let perUnit = toInt(
    m?.xp?.minutes?.perUnitMs ?? m?.xp?.minutes?.per5min,
    d.xp.minutes.perUnitMs ?? d.xp.minutes.per5min ?? 0
  );
  if (perUnit < 0) perUnit = 0;

  const list = Array.isArray(m?.xp?.minutes?.list) ? m.xp.minutes.list! : [];
  const unitMin = Math.max(1, Math.round(unitMs / 60000));
  const first = list[0] ?? { min: unitMin, xp: perUnit };
  m.xp.minutes = {
    unitMs,
    perUnitMs: perUnit,
    per5min: unitMin === 5 ? perUnit : undefined,
    list: [{ min: toInt(first.min, unitMin), xp: toInt(first.xp, perUnit) }, ...list.slice(1)],
  };

  m.xp.appointment.xp = toInt(m?.xp?.appointment?.xp, d.xp.appointment.xp);
  if (!m.xp.appointment.badge) m.xp.appointment.badge = d.xp.appointment.badge;

  m.approval.enabled = !!m?.approval?.enabled;
  m.approval.xp = toInt(m?.approval?.xp, d.approval.xp);
  if (!m.approval.badge) m.approval.badge = d.approval.badge;

  m.sales.milestones = (Array.isArray(m?.sales?.milestones) ? m.sales.milestones : []).map(
    (x: any) => ({
      amount: toInt(x?.amount, 0),
      xp: toInt(x?.xp, 0),
      badge: x?.badge ? String(x.badge) : undefined,
    })
  );

  return m;
}

async function ensureDir() {
  await fs.mkdir(RULES_DIR, { recursive: true });
}

function rulesPath(tenant: string) {
  return path.join(RULES_DIR, `${tenant}.json`);
}

async function loadFile(p: string) {
  try {
    const buf = await fs.readFile(p, "utf8");
    return JSON.parse(buf);
  } catch {
    return null;
  }
}

async function saveFile(p: string, obj: any) {
  await ensureDir();
  await fs.writeFile(p, JSON.stringify(obj, null, 2), "utf8");
}

/** GET /tenant/:id/rules */
export async function rulesGet(req: any, res: any) {
  try {
    const tenant = safeTenant(req.params?.id);
    const file = rulesPath(tenant);
    const raw = await loadFile(file);
    const out = normalize(raw);
    res.json(out);
  } catch (e: any) {
    log(`[rulesGet] error: ${e?.message || e}`);
    res.status(500).json({ ok: false, error: String(e) });
  }
}

/** PUT /tenant/:id/rules */
export async function rulesPut(req: any, res: any) {
  try {
    const tenant = safeTenant(req.params?.id);
    const file = rulesPath(tenant);
    const current = normalize(await loadFile(file));
    const patch = req.body || {};
    const merged = normalize(deepMerge(current, patch));
    await saveFile(file, merged);
    res.json(merged);
  } catch (e: any) {
    log(`[rulesPut] error: ${e?.message || e}`);
    res.status(500).json({ ok: false, error: String(e) });
  }
}

/** 互換: 今日の統計（必要になったら実装拡張） */
export async function statsToday(_req: any, res: any) {
  res.json({ ok: true });
}
