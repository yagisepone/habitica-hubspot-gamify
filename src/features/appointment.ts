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
import { addAppointment } from "../connectors/habitica.js";
import { sendChatworkMessage, cwApptText } from "../connectors/chatwork.js";
import { hasSeen, markSeen } from "../lib/seen.js";
import { getObservedLabelIds, getObservedLabelTitles } from "../store/labels.js";

export type Normalized = {
  source: "v3" | "workflow" | "zoom";
  eventId?: any;
  callId?: any;
  outcome?: string;
  occurredAt?: any;
  raw?: any;
  /** テナントID（なければ default） */
  tenant?: string;
};

/** outcome がアポ対象かどうかを判定（テナント設定優先、無ければENVを使用） */
function isAppointmentOutcome(tenant: string, outcome: string): boolean {
  const v = String(outcome || "").trim().toLowerCase();
  if (!v) return false;

  // UI（/tenant/:id/labels）で保存されたラベルID/タイトルを優先
  const ids = (getObservedLabelIds(tenant) || []).map((s) => String(s).toLowerCase());
  const titles = (getObservedLabelTitles(tenant) || []).map((s) => String(s).toLowerCase());
  if (ids.length || titles.length) {
    return ids.includes(v) || titles.includes(v);
  }

  // フォールバック：.env の APPOINTMENT_VALUES
  const envVals = (APPOINTMENT_VALUES || []).map((s) => String(s).toLowerCase());
  return envVals.includes(v);
}

export async function handleNormalizedEvent(ev: Normalized) {
  const id = ev.eventId ?? ev.callId;
  if (hasSeen(id)) return;
  markSeen(id);

  const tenant = (ev.tenant || ev.raw?.tenant || "default") as string;
  const rawOutcome = String(ev.outcome || "").trim();

  if (isAppointmentOutcome(tenant, rawOutcome)) {
    await awardXpForAppointment(ev, tenant);
    await notifyChatworkAppointment(ev);
  } else {
    log(`non-appointment outcome=${rawOutcome || "(empty)"} tenant=${tenant}`);
  }
}

async function awardXpForAppointment(ev: Normalized, tenant: string) {
  const who = resolveActor({ source: ev.source as any, raw: ev.raw });
  const cred = getHabitica(who.email);
  const when = fmtJST(ev.occurredAt);

  appendJsonl("data/events/appointments.jsonl", {
    at: new Date().toISOString(),
    day: fmtJST(ev.occurredAt).slice(0, 10).replace(/\./g, "-"),
    callId: ev.callId,
    actor: who,
    tenant,
    outcome: String(ev.outcome || ""),
  });

  // いまは共通のAPPOINTMENT_XP。将来ラベル別XPにする場合はここで分岐可能。
  const xp = APPOINTMENT_XP;

  if (!cred || DRY_RUN) {
    log(
      `[XP] appointment +${xp}XP (DRY_RUN or no-cred) callId=${ev.callId} by=${who.name} @${when} tenant=${tenant}`
    );
    return;
  }
  await habSafe(async () => {
    await addAppointment(cred, xp, APPOINTMENT_BADGE_LABEL);
    return undefined as any;
  });
}

async function notifyChatworkAppointment(ev: Normalized) {
  try {
    const who = resolveActor({ source: ev.source as any, raw: ev.raw });
    await sendChatworkMessage(cwApptText(who.name));
  } catch {}
}
