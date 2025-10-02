// src/features/habitica_daily.ts
import { Request, Response } from "express";
import {
  DAILY_BONUS_XP,
  DAILY_TASK_MATCH,
  DRY_RUN,
  HABITICA_WEBHOOK_SECRET,
} from "../lib/env.js";
import { appendJsonl, isoDay, log } from "../lib/utils.js";
import { getHabitica, MAIL2NAME } from "../lib/maps.js";
import { habSafe } from "../lib/habiticaQueue.js";
import { createTodo, completeTask } from "../connectors/habitica.js";
import { hasSeen, markSeen } from "../lib/seen.js";

function isDailyTaskTitle(title?: string) {
  const t = String(title || "").trim();
  if (!t) return false;
  return DAILY_TASK_MATCH.some((k) => t.includes(k));
}

function hasDailyBonusGiven(email: string, day: string) {
  return hasSeen(`daily:${day}:${email}`);
}
function markDailyBonusGiven(email: string, day: string) {
  markSeen(`daily:${day}:${email}`);
}

export async function habiticaWebhook(req: Request, res: Response) {
  const token = String((req.query as any).t || (req.query as any).token || "").trim();
  if (!token || token !== HABITICA_WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: "auth" });
  }
  const email = String((req.query as any).email || "").toLowerCase();
  if (!email) return res.status(400).json({ ok: false, error: "missing email" });

  const body: any = (req as any).body || {};
  const task = body.task || body.data?.task || body.data || {};
  const text = String(task.text || task.title || "");
  const completed = task.completed === true || String(body.direction || "").toLowerCase() === "up";

  if (!isDailyTaskTitle(text) || !completed) {
    return res.json({ ok: true, skipped: true });
  }

  const day = isoDay();
  if (hasDailyBonusGiven(email, day)) {
    return res.json({ ok: true, duplicate: true });
  }

  const cred = getHabitica(email);
  if (!cred || DRY_RUN) {
    log(`[daily] +${DAILY_BONUS_XP}XP (DRY_RUN or no-cred) email=${email} task="${text}"`);
    appendJsonl("data/events/daily_bonus.jsonl", {
      at: new Date().toISOString(),
      day,
      email,
      task: text,
      dry_run: true,
    });
    markDailyBonusGiven(email, day);
    return res.json({ ok: true, dryRun: true });
  }

  try {
    await habSafe(async () => {
      const title = `🗓日報ボーナス（${MAIL2NAME[email] || email.split("@")[0]}） +${DAILY_BONUS_XP}XP`;
      const notes = `rule=daily+${DAILY_BONUS_XP}\nsource=habitica_webhook\ntask="${text}"`;
      const todo = await createTodo(title, notes, undefined, cred);
      const id = (todo as any)?.id;
      if (id) await completeTask(id, cred);
      return undefined as any;
    });
    appendJsonl("data/events/daily_bonus.jsonl", {
      at: new Date().toISOString(),
      day,
      email,
      task: text,
    });
    log(`[daily] +${DAILY_BONUS_XP}XP by=${email} task="${text}"`);
    markDailyBonusGiven(email, day);
    res.json({ ok: true, awarded: DAILY_BONUS_XP });
  } catch (e: any) {
    console.error("[daily] habitica award failed:", e?.message || e);
    res.status(500).json({ ok: false });
  }
}
