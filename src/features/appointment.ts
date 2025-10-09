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
import {
  getObservedLabelIds,
  getObservedLabelTitles,
} from "../store/labels.js";

/** 文字列化/小文字化のヘルパー（String(...) は使わない） */
const asStr = (v: unknown): string => "" + (v ?? "");
const lc = (v: unknown): string => asStr(v).toLowerCase();

/** このファイル内だけで完結する LabelItem 型（UI で扱うラベル） */
type LabelItem = {
  id?: string;
  title?: string;
  category?: string; // "appointment" など
  xp?: number;
  badge?: string;
  enabled?: boolean;
};

export type Normalized = {
  source: "v3" | "workflow" | "zoom";
  eventId?: any;
  callId?: any;
  outcome?: string; // 例: "新規アポ", "ニーズ無し", "見込みA" など
  occurredAt?: any;
  raw?: any; // HubSpot 生データ
  tenant?: string; // 未指定なら default
};

/** HubSpot 風の ID 候補をできる限り拾う */
function pickHubSpotLikeIds(raw: any): string[] {
  const out: string[] = [];
  const push = (v: any) => {
    if (Array.isArray(v)) v.forEach(push);
    else if (v !== null && v !== undefined) out.push(String(v));
  };
  try {
    // ベタにトップレベル / properties の両方を舐める
    push(raw?.labelId);
    push(raw?.labelIds);
    push(raw?.hs_label_id);
    push(raw?.hs_outcome_id);
    push(raw?.hs_pipeline_stage);
    push(raw?.hs_task_type_id);
    push(raw?.hs_dealstage);

    const p = raw?.properties ?? {};
    push(p.labelId);
    push(p.labelIds);
    push(p.hs_label_id);
    push(p.hs_outcome_id);
    push(p.hs_pipeline_stage);
    push(p.hs_task_type_id);
    push(p.hs_dealstage);
  } catch {
    /* noop */
  }
  return out.filter(Boolean).map(asStr);
}

/** UI 保存のラベル一覧を取得し、appointment カテゴリで返却 */
async function loadUiLabels(tenant: string): Promise<LabelItem[]> {
  const ids =
    ((await getObservedLabelIds(tenant)) ?? []).map((s: unknown) => asStr(s));
  const titles =
    ((await getObservedLabelTitles(tenant)) ?? []).map((s: unknown) => asStr(s));
  return [
    ...ids.map((id: string) => ({
      id,
      category: "appointment",
      enabled: true,
    })),
    ...titles.map((title: string) => ({
      title,
      category: "appointment",
      enabled: true,
    })),
  ];
}

/** 重複キー（id/title/category）を排除 */
function uniq(items: LabelItem[]): LabelItem[] {
  const seen = new Set<string>();
  const out: LabelItem[] = [];
  for (const it of items) {
    const key = `${lc(it.category || "")}|${asStr(it.id).trim()}|${lc(
      asStr(it.title)
    )}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/** UI のラベル定義と outcome 文言 / id 候補で照合 */
async function matchUiLabels(
  tenant: string,
  outcomeText: string,
  idCands: string[]
): Promise<LabelItem[]> {
  const items = await loadUiLabels(tenant);
  const outcomeLc = lc(outcomeText);
  const matched: LabelItem[] = [];

  for (const it of items) {
    if (it.enabled === false) continue;
    const byId = !!it.id && idCands.includes(asStr(it.id));
    const byTitle = !!it.title && outcomeLc === lc(it.title);
    if (byId || byTitle) {
      matched.push({
        ...it,
        category: lc(it.category || "label"),
        xp: Number.isFinite(Number(it.xp))
          ? Math.max(0, Math.floor(Number(it.xp)))
          : undefined,
      });
    }
  }
  return uniq(matched);
}

/** 環境変数のアポ判定（フォールバック） */
function matchEnvAppointment(outcomeText: string): boolean {
  const t = lc(outcomeText).trim();
  return !!t && (APPOINTMENT_VALUES ?? []).map(lc).includes(t);
}

/** エントリポイント：正規化イベント処理（既存機能は維持） */
export async function handleNormalizedEvent(ev: Normalized) {
  const id = ev.eventId ?? ev.callId;
  if (hasSeen(id)) return;
  markSeen(id);

  const tenant = String(ev.tenant || "default");
  const outcomeText = asStr(ev.outcome || "");
  const idCands = pickHubSpotLikeIds(ev.raw);

  const matched = await matchUiLabels(tenant, outcomeText, idCands);
  const envAppt = matchEnvAppointment(outcomeText);

  const hasUiAppointment = matched.some(
    (m) => (m.category || "appointment") === "appointment"
  );
  const xpItems = matched.filter((m) => (m.xp ?? 0) > 0);

  // ===== XP 付与（UI に XP が設定されているラベルは全て付与）=====
  if (xpItems.length) {
    for (const m of xpItems) {
      await awardXpForLabel(ev, m);
    }
  } else if (hasUiAppointment || envAppt) {
    // UI 側で XP 未設定の「アポ」or ENV のアポは従来の既定 XP を付与
    await awardXpForAppointment(ev);
    await notifyChatworkAppointment(ev);
  }

  // ===== 記録（ダッシュボード拡張用の生データ）=====
  if (matched.length) {
    await recordLabelEvents(ev, matched);
  } else {
    log(
      `non-appointment outcome=${outcomeText || "(empty)"} (no UI label match)`
    );
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
    label: {
      id: it.id || null,
      title: it.title || null,
      category: (it.category || "label").toLowerCase(),
    },
    xp,
  });

  if (!cred || DRY_RUN || xp <= 0) {
    log(
      `[XP] label '${badge}' +${xp}XP (DRY_RUN or no-cred) callId=${ev.callId} by=${who.name}`
    );
    return;
  }
  await habSafe(async () => {
    // 汎用 XP 付与に addAppointment を流用（バッジ名に label/title を使う）
    await addAppointment(cred, xp, String(badge));
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
    log(
      `[XP] appointment +${APPOINTMENT_XP}XP (DRY_RUN or no-cred) callId=${ev.callId} by=${who.name}`
    );
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
  } catch {
    /* noop */
  }
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
        xp: Number.isFinite(Number(m.xp))
          ? Math.max(0, Math.floor(Number(m.xp)))
          : 0,
      },
      outcomeText: ev.outcome || null,
    });
  }
}
