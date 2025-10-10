// @ts-nocheck
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
import {
  getObservedLabelIds,
  getObservedLabelTitles,
  getLabelItems,
} from "../store/labels.js";

const asStr = (v: unknown) => "" + (v ?? "");
const lc = (v: unknown) => asStr(v).toLowerCase();
const arr = (v: any): any[] =>
  Array.isArray(v) ? v : v && Array.isArray(v.items) ? v.items : [];

type LabelItem = { id?: string; title?: string; category?: string; enabled?: boolean; xp?: number; badge?: string; };
export type Normalized = { source: "v3" | "workflow" | "zoom"; eventId?: any; callId?: any; outcome?: string; occurredAt?: any; raw?: any; tenant?: string; };

/* --- 省略：pickHubSpotLikeIds / loadUiLabels / uniq / matchUiLabels / matchEnvAppointment は前回版と同じ --- */

/** アポイベントを必ず1行記録（tenant付き） */
async function recordAppointmentEvent(ev: Normalized) {
  const who = resolveActor({ source: ev.source as any, raw: ev.raw });
  appendJsonl("data/events/appointments.jsonl", {
    at: new Date().toISOString(),
    day: fmtJST(ev.occurredAt).slice(0, 10).replace(/\./g, "-"),
    tenant: asStr(ev.tenant || "default"),
    callId: ev.callId,
    actor: who,
    source: ev.source,
    outcomeText: ev.outcome || null,
  });
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

  // --- ここで「アポ」だと分かった時点で必ず記録 ---
  if (hasUiAppointment || envAppt) {
    await recordAppointmentEvent(ev);
  }

  // ラベルごとのXP付与
  if (xpItems.length) {
    for (const m of xpItems) await awardXpForLabel(ev, m);
  } else if (hasUiAppointment || envAppt) {
    // XP未設定のアポは既定XP + Chatwork
    await awardXpForAppointment(ev);
    await notifyChatworkAppointment(ev);
  }

  // 記録（ラベル）
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
    tenant: asStr(ev.tenant || "default"),
    callId: ev.callId,
    actor: who,
    label: { id: it.id || null, title: it.title || null, category: lc(it.category || "label") },
    xp,
  });

  if (!cred || DRY_RUN || xp <= 0) {
    log(`[XP] label '${badge}' +${xp}XP (DRY_RUN or no-cred) callId=${ev.callId} by=${who.name}`);
    return;
  }
  await habSafe(async () => { await addAppointment(cred, xp, asStr(badge)); return undefined as any; });
}

async function awardXpForAppointment(ev: Normalized) {
  const who = resolveActor({ source: ev.source as any, raw: ev.raw });
  const cred = getHabitica(who.email);

  if (!cred || DRY_RUN) {
    log(`[XP] appointment +${APPOINTMENT_XP}XP (DRY_RUN or no-cred) callId=${ev.callId} by=${who.name}`);
    return;
  }
  await habSafe(async () => { await addAppointment(cred, APPOINTMENT_XP, APPOINTMENT_BADGE_LABEL); return undefined as any; });
}

async function notifyChatworkAppointment(ev: Normalized) {
  try { const who = resolveActor({ source: ev.source as any, raw: ev.raw }); await sendChatworkMessage(cwApptText(who.name)); } catch {}
}

async function recordLabelEvents(ev: Normalized, matched: LabelItem[]) {
  const who = resolveActor({ source: ev.source as any, raw: ev.raw });
  const day = fmtJST(ev.occurredAt).slice(0, 10).replace(/\./g, "-");
  for (const m of matched) {
    appendJsonl("data/events/labels.jsonl", {
      at: new Date().toISOString(),
      day,
      tenant: asStr(ev.tenant || "default"),
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
