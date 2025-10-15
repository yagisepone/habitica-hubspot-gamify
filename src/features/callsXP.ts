// src/features/callsXP.ts
import {
  CALL_XP_PER_5MIN,
  CALL_XP_PER_CALL,
  CALL_XP_UNIT_MS,
  DRY_RUN,
  MAX_CALL_MS,
} from "../lib/env.js";
import { appendJsonl, fmtJST, isoDay, log } from "../lib/utils.js";
import { getHabitica } from "../lib/maps.js";
import { habSafe } from "../lib/habiticaQueue.js";
import { createTodo, completeTask, adjustUserStats } from "../connectors/habitica.js";
import { resolveActor } from "./resolveActor.js";
import { checkAndAwardBadges } from "./badges.js";

export type CallDurEv = {
  source: "v3" | "workflow" | "zoom";
  eventId?: any;
  callId?: any;
  durationMs: number;
  occurredAt?: any;
  raw?: any;
};

export function inferDurationMs(v: any) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= MAX_CALL_MS && n % 1000 === 0) return Math.min(n, MAX_CALL_MS); // ms想定
  if (n <= 10800) return Math.min(n * 1000, MAX_CALL_MS); // 秒→ms
  return Math.min(n, MAX_CALL_MS);
}

function computePerCallExtra(ms: number) {
  return ms > 0 ? Math.floor(ms / CALL_XP_UNIT_MS) * CALL_XP_PER_5MIN : 0;
}

function isMissedCall(ev: CallDurEv): boolean {
  const raw = ev.raw || {};
  const statusRaw =
    raw.status ||
    raw.call_status ||
    raw.result ||
    raw.callResult ||
    raw.callStatus;
  const status = statusRaw ? String(statusRaw).toLowerCase() : "";
  if (status.includes("miss")) return true;
  if (status.includes("no_answer")) return true;
  const labels = Array.isArray(raw.labels) ? raw.labels : Array.isArray(raw.tags) ? raw.tags : [];
  if (labels.some((label: any) => String(label).includes("ミス架電"))) return true;
  if (ev.durationMs <= 0) return true;
  return false;
}

async function applyMissPenalty(ev: CallDurEv, userId?: string) {
  if (!userId) return;
  const magnitude = Number.isFinite(CALL_XP_PER_CALL) && CALL_XP_PER_CALL !== 0 ? Math.abs(Number(CALL_XP_PER_CALL)) : 1;
  const penalty = -Math.abs(magnitude || 1);
  if (penalty === 0) return;
  const tenantId = String(ev.raw?.tenantId || "default");
  await adjustUserStats(tenantId, userId, penalty);
  log(`[penalty] call tenant=${tenantId} user=${userId} xp=${penalty}`);
  try {
    await checkAndAwardBadges(tenantId, userId, {
      type: "call",
      metrics: { deltaXp: penalty, callDurationMs: Number(ev.durationMs) || 0 },
      labels: Array.isArray(ev.raw?.labels) ? ev.raw.labels : undefined,
    });
  } catch (err: any) {
    log(`[penalty] badge-check error=${err?.message || err}`);
  }
}

export async function awardXpForCallDuration(ev: CallDurEv) {
  if (ev.source !== "zoom") {
    console.log(`[call] skip non-zoom source=${ev.source} durMs=${ev.durationMs}`);
    return;
  }

  let durMs = Math.floor(Number(ev.durationMs || 0));
  if (!Number.isFinite(durMs) || durMs < 0) durMs = 0;
  if (durMs > MAX_CALL_MS) durMs = MAX_CALL_MS;

  const when = fmtJST(ev.occurredAt);
  const who = resolveActor({ source: ev.source, raw: ev.raw });

  if (isMissedCall(ev)) {
    await applyMissPenalty(ev, who.email || who.name);
    return;
  }

  console.log(
    `[call] calc who=${who.email || who.name} durMs=${durMs} unit=${Number(
      CALL_XP_UNIT_MS
    )} per5=${Number(CALL_XP_PER_5MIN)}`
  );

  appendJsonl("data/events/calls.jsonl", {
    at: new Date().toISOString(),
    day: isoDay(ev.occurredAt),
    callId: ev.callId,
    ms: durMs,
    actor: who,
  });

  // +1XP/コール
  if (CALL_XP_PER_CALL > 0) {
    const cred = getHabitica(who.email);
    if (!cred || DRY_RUN) {
      log(`[call] per-call base +${CALL_XP_PER_CALL}XP (DRY_RUN or no-cred) by=${who.name} @${when}`);
    } else {
      await habSafe(async () => {
        const title = `📞 架電（${who.name}） +${CALL_XP_PER_CALL}XP`;
        const notes = `rule=per-call+${CALL_XP_PER_CALL}`;
        const todo = await createTodo(title, notes, undefined, cred);
        const id = (todo as any)?.id;
        if (id) await completeTask(id, cred);
        return undefined as any;
      });
    }
  }

  if (durMs >= MAX_CALL_MS) {
    console.log("[call] guard: durMs hit MAX_CALL_MS; suppress 5min extra, keep +1XP only");
    return;
  }

  // 5分ごとXP
  const xpExtra = computePerCallExtra(durMs);
  if (xpExtra <= 0) return;
  const cred = getHabitica(who.email);
  if (!cred || DRY_RUN) {
    log(`[call] per-call extra (5min) xp=${xpExtra} (DRY_RUN or no-cred) by=${who.name} @${when}`);
    return;
  }
  await habSafe(async () => {
    const title = `📞 架電（${who.name}） +${xpExtra}XP（5分加点）`;
    const notes = `extra: ${CALL_XP_PER_5MIN}×floor(${durMs}/${CALL_XP_UNIT_MS})`;
    const todo = await createTodo(title, notes, undefined, cred);
    const id = (todo as any)?.id;
    if (id) await completeTask(id, cred);
    return undefined as any;
  });

  const tenantId = String(ev.raw?.tenantId || "default");
  try {
    await checkAndAwardBadges(tenantId, who.email || who.name, {
      type: "call",
      metrics: {
        deltaXp: (CALL_XP_PER_CALL || 0) + xpExtra,
        callDurationMs: durMs,
        totalCallDurationMs: durMs,
      },
      labels: Array.isArray(ev.raw?.labels) ? ev.raw.labels : undefined,
    });
  } catch (err: any) {
    log(`[call] badge-check error=${err?.message || err}`);
  }
}

export async function handleCallDurationEvent(ev: CallDurEv) {
  await awardXpForCallDuration(ev);
}
