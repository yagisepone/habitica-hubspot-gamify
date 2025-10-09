// @ts-nocheck
// src/features/appointment.ts
// UI保存のラベル定義に基づき、任意ラベルへのXP付与を実現。
// 「既定アポXP」「Chatwork通知」「イベント記録」も維持。

import {
  APPOINTMENT_BADGE_LABEL,
  APPOINTMENT_VALUES,
  APPOINTMENT_XP,
  DRY_RUN,
} from "../lib/env.js";
import { appendJsonl, fmtJST, log } from "../lib/utils.js";
import { resolveActor } from "./resolveActor.js";
import { getHabitica } from "../lib/maps.js";
import { habSafe } from "../lib/habiticaQueue.js";
import { addAppointment } from "../connectors/habitica.js";
import { sendChatworkMessage, cwApptText } from "../connectors/chatwork.js";
import { hasSeen, markSeen } from "../lib/seen.js";

// ★ ここを星取込みに変更（関数でも配列でも耐える）
import * as labelsStore from "../store/labels.js";

const asStr = (v: unknown) => "" + (v ?? "");
const lc = (v: unknown) => asStr(v).toLowerCase();
const arr = (v: any): any[] =>
  Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);

type LabelItem = {
  id?: string;
  title?: string;
  category?: string;   // "appointment" / "label"
  enabled?: boolean;
  xp?: number;
  badge?: string;
};

export type Normalized = {
  source: "v3" | "workflow" | "zoom";
  eventId?: any;
  callId?: any;
  outcome?: string;
  occurredAt?: any;
  raw?: any;
  tenant?: string;
};

// ---------- store/labels.js ラッパ ----------
async function readLabelItems(tenant: string): Promise<any[]> {
  try {
    const fn = (labelsStore as any).getLabelItems;
    const v = typeof fn === "function" ? await Promise.resolve(fn(tenant)) : (labelsStore as any).items;
    return arr(v);
  } catch { return []; }
}
async function readObservedIds(tenant: string): Promise<string[]> {
  try {
    const fn = (labelsStore as any).getObservedLabelIds;
    const v = typeof fn === "function" ? await Promise.resolve(fn(tenant)) : (labelsStore as any).observedIds;
    return arr(v).map(asStr);
  } catch { return []; }
}
async function readObservedTitles(tenant: string): Promise<string[]> {
  try {
    const fn = (labelsStore as any).getObservedLabelTitles;
    const v = typeof fn === "function" ? await Promise.resolve(fn(tenant)) : (labelsStore as any).observedTitles;
    return arr(v).map(asStr);
  } catch { return []; }
}

/** HubSpot 風の ID 候補を広く拾う */
function pickHubSpotLikeIds(raw: any): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(push);
    else if (v !== null && v !== undefined) out.push(asStr(v));
  };
  if (!raw) return out;
  try {
    push(raw.labelId);
    push(raw.labelIds);
    push(raw.hs_label_id);
    push(raw.hs_outcome_id);
    push(raw.hs_pipeline_stage);
    push(raw.hs_task_type_id);
    push(raw.hs_dealstage);
    if (raw.properties) {
      const p = raw.properties;
      push(p.labelId);
      push(p.labelIds);
      push(p.hs_label_id);
      push(p.hs_outcome_id);
      push(p.hs_pipeline_stage);
      push(p.hs_task_type_id);
      push(p.hs_dealstage);
    }
  } catch {}
  return out.filter(Boolean).map(asStr);
}

/** UI保存分の items を最優先。無ければ observed の ID/タイトルで補完。 */
async function loadUiLabels(tenant: string): Promise<LabelItem[]> {
  const [itemsRaw, idsRaw, titlesRaw] = await Promise.all([
    readLabelItems(tenant),
    readObservedIds(tenant),
    readObservedTitles(tenant),
  ]);

  const items = arr(itemsRaw);
  if (items.length) {
    return items.map((it: any) => ({
      id: it?.id ? asStr(it.id) : undefined,
      title: it?.title ? asStr(it.title) : undefined,
      category: it?.category ? lc(it.category) : (it?.title || it?.id ? "appointment" : "label"),
      enabled: it?.enabled !== false,
      xp: Number.isFinite(Number(it?.xp)) ? Math.max(0, Math.floor(Number(it?.xp))) : undefined,
      badge: it?.badge ? asStr(it.badge) : undefined,
    }));
  }

  // フォールバック：observed の ID/タイトル
  const ids = arr(idsRaw).map(asStr);
  const titles = arr(titlesRaw).map(asStr);
  return [
    ...ids.map((id)    => ({ id,    category: "appointment", enabled: true } as LabelItem)),
    ...titles.map((t)  => ({ title: t, category: "appointment", enabled: true } as LabelItem)),
  ];
}

function uniq(items: LabelItem[]): LabelItem[] {
  const seen = new Set<string>();
  const out: LabelItem[] = [];
  for (const it of items) {
    const key = `${lc(it.category || "label")}|${asStr(it.id || "").trim()}|${lc(asStr(it.title || ""))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/** UI保存ラベル定義と outcome 文字 / id候補 で照合 */
async function matchUiLabels(tenant: string, outcomeText: string, idCands: string[]): Promise<LabelItem[]> {
  const items = await loadUiLabels(tenant);
  const outcomeLc = lc(outcomeText).trim();
  const matched: LabelItem[] = [];
  for (const it of items) {
    if (it.enabled === false) continue;
    const byId    = it.id    && idCands.includes(asStr(it.id));
    const byTitle = it.title && outcomeLc && outcomeLc === lc(it.title);
    if (byId || byTitle) {
      matched.push({
        ...it,
        category: lc(it.category || "label"),
        xp: Number.isFinite(Number(it.xp)) ? Math.max(0, Math.floor(Number(it.xp))) : undefined,
      });
    }
  }
  return uniq(matched);
}

/** ENV(APPOINTMENT_VALUES) による既定のアポ判定 */
function matchEnvAppointment(outcomeText: string): boolean {
  const t = lc(outcomeText).trim();
  const raw: any = APPOINTMENT_VALUES;
  const envVals = Array.isArray(raw) ? raw : (typeof raw === "string" ? raw.split(",") : []);
  return !!t && envVals.map(lc).includes(t);
}

/** メイン：イベント処理 */
export async function handleNormalizedEvent(ev: Normalized) {
  const id = ev.eventId ?? ev.callId;
  if (hasSeen(id)) return;
  markSeen(id);

  const tenant = asStr(ev.tenant || "default");
  const outcomeText = asStr(ev.outcome || "");
  const idCands = pickHubSpotLikeIds(ev.raw);

  const matched = await matchUiLabels(tenant, outcomeText, idCands);
  const envAppt = matchEnvAppointment(outcomeText);

  const hasUiAppointment = matched.some((m) => (m.category || "appointment") === "appointment");
  const xpItems = matched.filter((m) => (m.xp ?? 0) > 0);

  // ===== ラベルごとのXP付与（UIでXPが入っているものは全部付与）=====
  if (xpItems.length) {
    for (const m of xpItems) await awardXpForLabel(ev, m);
  } else if (hasUiAppointment || envAppt) {
    // UI側でXP未設定の「アポ」または ENVアポ → 既定アポXP + Chatwork
    await awardXpForAppointment(ev);
    await notifyChatworkAppointment(ev);
  }

  // ===== 記録（ダッシュボード拡張用の生データ）=====
  if (matched.length) {
    await recordLabelEvents(ev, matched);
  } else {
    log(`non-appointment outcome=${outcomeText || "(empty)"} (no UI label match)`);
  }
}

async function awardXpForLabel(ev: Normalized, it: LabelItem) {
  const who = resolveActor({ source: ev.source as any, raw: ev.raw });
  const cred = getHabitica(who.email);
  const xp = Math.max(0, Math.floor(Number(it.xp ?? 0)));
  const badge = it.badge || it.title || (it.category || "label");

  appendJsonl("data/events/labels-xp.jsonl", {
    at: new Date().toISOString(),
    day: fmtJST(ev.occurredAt).slice(0, 10).replace(/\./g, "-"),
    callId: ev.callId,
    actor: who,
    label: { id: it.id || null, title: it.title || null, category: lc(it.category || "label") },
    xp,
  });

  if (!cred || DRY_RUN || xp <= 0) {
    log(`[XP] label '${badge}' +${xp}XP (DRY_RUN or no-cred) callId=${ev.callId} by=${who.name}`);
    return;
  }
  await habSafe(async () => {
    await addAppointment(cred, xp, asStr(badge)); // addAppointment を汎用XPにも流用
    return undefined as any;
  });
}

async function awardXpForAppointment(ev: Normalized) {
  const who = resolveActor({ source: ev.source as any, raw: ev.raw });
  const cred = getHabitica(who.email);

  appendJsonl("data/events/appointments.jsonl", {
    at: new Date().toISOString(),
    day: fmtJST(ev.occurredAt).slice(0, 10).replace(/\./g, "-"),
    callId: ev.callId,
    actor: who,
  });

  if (!cred || DRY_RUN) {
    log(`[XP] appointment +${APPOINTMENT_XP}XP (DRY_RUN or no-cred) callId=${ev.callId} by=${who.name}`);
    return;
  }
  await habSafe(async () => {
    await addAppointment(cred, APPOINTMENT_XP, APPOINTMENT_BADGE_LABEL);
    return undefined as any;
  });
}

async function notifyChatworkAppointment(ev: Normalized) {
  try {
    const who = resolveActor({ source: ev.source as any, raw: ev.raw });
    await sendChatworkMessage(cwApptText(who.name));
  } catch {}
}

async function recordLabelEvents(ev: Normalized, matched: LabelItem[]) {
  const who = resolveActor({ source: ev.source as any, raw: ev.raw });
  const day = fmtJST(ev.occurredAt).slice(0, 10).replace(/\./g, "-");
  for (const m of matched) {
    appendJsonl("data/events/labels.jsonl", {
      at: new Date().toISOString(),
      day,
      callId: ev.callId,
      actor: who,
      label: {
        id: m.id || null,
        title: m.title || null,
        category: lc(m.category || "label"),
        xp: Number.isFinite(Number(m.xp)) ? Math.max(0, Math.floor(Number(m.xp))) : 0,
      },
      outcomeText: ev.outcome || null,
    });
  }
}
