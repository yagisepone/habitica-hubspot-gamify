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
import { createTodo, completeTask } from "../connectors/habitica.js";
import { resolveActor } from "./resolveActor.js";

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
}

export async function handleCallDurationEvent(ev: CallDurEv) {
  await awardXpForCallDuration(ev);
}
