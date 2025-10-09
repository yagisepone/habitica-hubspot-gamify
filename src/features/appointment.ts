// src/features/appointment.ts
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
import { addAppointment } from "../connectors/habitica.js"; // 汎用XPでも再利用
import { sendChatworkMessage, cwApptText } from "../connectors/chatwork.js";
import { hasSeen, markSeen } from "../lib/seen.js";
import {
  getLabelItems,
  getObservedLabelIds,
  getObservedLabelTitles,
  LabelItem,
} from "../store/labels.js";

export type Normalized = {
  source: "v3" | "workflow" | "zoom";
  eventId?: any;
  callId?: any;
  outcome?: string;      // 例: "新規アポ", "ニーズ無し", "見込みA" など
  occurredAt?: any;
  raw?: any;             // HubSpot生データ
  tenant?: string;       // 未指定なら default
};

function pickHubSpotLikeIds(raw: any): string[] {
  const out: string[] = [];
  const push = (v: any) => {
    if (Array.isArray(v)) v.forEach(push);
    else if (v !== null && v !== undefined) out.push(String(v));
  };
  if (!raw) return out;
  try {
    push((raw as any).labelId);
    push((raw as any).labelIds);
    push((raw as any).hs_label_id);
    push((raw as any).hs_outcome_id);
    push((raw as any).hs_pipeline_stage);
    push((raw as any).hs_task_type_id);
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
  return out.filter(Boolean).map(String);
}

function uniqItems(items: LabelItem[]): LabelItem[] {
  const seen = new Set<string>();
  const out: LabelItem[] = [];
  for (const it of items) {
    const key = `${(it.category || "appointment").toLowerCase()}|${(it.id || "").trim()}|${(it.title || "").trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function matchUiLabels(tenant: string, outcomeText: string, idCands: string[]) {
  const items = getLabelItems(tenant);
  const outcomeLc = String(outcomeText || "").trim().toLowerCase();
  const matched: LabelItem[] = [];
  for (const it of items) {
    if (it.enabled === false) continue;
    const byId = it.id && idCands.includes(String(it.id));
    const byTitle = it.title && outcomeLc && outcomeLc === String(it.title).trim().toLowerCase();
    if (byId || byTitle) {
      matched.push({
        ...it,
        category: (it.category || "appointment").toLowerCase(),
        xp: isFinite(Number(it.xp)) ? Math.max(0, Math.floor(Number(it.xp))) : undefined,
      });
    }
  }
  return uniqItems(matched);
}

function matchEnvAppointment(outcomeText: string): boolean {
  const t = String(outcomeText || "").trim().toLowerCase();
  return !!t && APPOINTMENT_VALUES.includes(t);
}

export async function handleNormalizedEvent(ev: Normalized) {
  const id = ev.eventId ?? ev.callId;
  if (hasSeen(id)) return;
  markSeen(id);

  const tenant = String(ev.tenant || "default");
  const outcomeText = String(ev.outcome || "");
  const idCands = pickHubSpotLikeIds(ev.raw);

  const matched = matchUiLabels(tenant, outcomeText, idCands);
  const envAppt = matchEnvAppointment(outcomeText);

  const hasUiAppointment = matched.some((m) => (m.category || "appointment") === "appointment");
  const xpItems = matched.filter((m) => (m.xp ?? 0) > 0);

  // ===== XP 付与（UIにXPが設定されているラベルは全て付与）=====
  if (xpItems.length) {
    for (const m of xpItems) {
      await awardXpForLabel(ev, m);
    }
  } else if (hasUiAppointment || envAppt) {
    // UI側でXP未設定の「アポ」または env のアポは従来の既定XPを付与
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
    label: { id: it.id || null, title: it.title || null, category: (it.category || "label").toLowerCase() },
    xp,
  });

  if (!cred || DRY_RUN || xp <= 0) {
    log(`[XP] label '${badge}' +${xp}XP (DRY_RUN or no-cred) callId=${ev.callId} by=${who.name}`);
    return;
  }
  await habSafe(async () => {
    await addAppointment(cred, xp, String(badge)); // addAppointment を汎用XPにも流用
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
        category: (m.category || "label").toLowerCase(),
        xp: isFinite(Number(m.xp)) ? Math.max(0, Math.floor(Number(m.xp))) : 0,
      },
      outcomeText: ev.outcome || null,
    });
  }
}
