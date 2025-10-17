// NEW
import { promises as fs } from "fs";
import path from "path";
import { appendJsonl, isoDay, log } from "../lib/utils.js";
import { getHabitica } from "../lib/maps.js";
import { habSafe } from "../lib/habiticaQueue.js";
import { createTodo, completeTask } from "../connectors/habitica.js";
import { cwMakerAchievementText, sendChatworkMessage } from "../connectors/chatwork.js";
import { hasSeen, markSeen } from "../lib/seen.js";
import type { TrophyRule } from "../routes/rules.js";

const EV_DIR = "data/events";

const readJsonl = async <T = any>(file: string): Promise<T[]> => {
  try {
    const txt = await fs.readFile(file, "utf8");
    return txt
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as T;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as T[];
  } catch {
    return [];
  }
};

const lc = (s?: string) => String(s ?? "").toLowerCase().trim();

type TrophyWindow = TrophyRule["window"];

function inWindow(ts: number, now: number, window: TrophyWindow) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const end = today.getTime() + 86400000;
  let start = end - 86400000;
  switch (window.type) {
    case "daily":
      start = end - 86400000;
      break;
    case "weekly":
      start = end - 7 * 86400000;
      break;
    case "monthly": {
      const first = new Date(today);
      first.setDate(1);
      start = first.getTime();
      break;
    }
    case "rolling": {
      const days = Math.max(1, window.days ?? 7);
      start = end - days * 86400000;
      break;
    }
    default:
      start = end - 86400000;
      break;
  }
  return ts >= start && ts < end;
}

const keyFor = (rule: TrophyRule, email: string, now: number) =>
  `trophy:${rule.id}:${isoDay(now)}:${email.toLowerCase()}`;

async function award(email: string, xp: number, badge?: string) {
  const cred = getHabitica(email);
  if (!cred) {
    log(`[trophy] credential missing for ${email}`);
    return;
  }
  await habSafe(async () => {
    const title = `${badge || "称号達成"} +${Math.max(0, xp)}XP`;
    const todo = await createTodo(title, "source=trophies", undefined, cred);
    const id = (todo as any)?.id;
    if (id) await completeTask(id, cred);
    return undefined as any;
  });
}

type BaseEv = { at?: string; day?: string; occurredAt?: any; actor?: { email?: string } };
type CallEv = BaseEv & { ms?: number; dir?: string };
type ApptEv = BaseEv;
type LabelEv = BaseEv & { label?: { id?: string; title?: string; category?: string } };
type ApproveEv = BaseEv & { maker?: string };
type SalesEv = BaseEv & { maker?: string; amount?: number };

export async function runTrophyAggregation(tenant: string, rules: TrophyRule[], now = Date.now()) {
  const calls = await readJsonl<CallEv>(path.join(EV_DIR, "calls.jsonl"));
  const appts = await readJsonl<ApptEv>(path.join(EV_DIR, "appointments.jsonl"));
  const labels = await readJsonl<LabelEv>(path.join(EV_DIR, "labels.jsonl"));
  const approvals = await readJsonl<ApproveEv>(path.join(EV_DIR, "approvals.jsonl"));
  const sales = await readJsonl<SalesEv>(path.join(EV_DIR, "sales.jsonl"));

  for (const rule of rules ?? []) {
    if (rule.enabled === false) continue;

    const bucket = new Map<string, { count: number; minutes: number; amount: number }>();
    const touch = (email?: string) => {
      const key = lc(email);
      if (!key) return undefined;
      if (!bucket.has(key)) bucket.set(key, { count: 0, minutes: 0, amount: 0 });
      return bucket.get(key)!;
    };
    const within = (ts: any) => {
      const time = Number(new Date(ts ?? now));
      if (!Number.isFinite(time)) return false;
      return inWindow(time, now, rule.window || { type: "daily" });
    };
    const matchLabel = (entry: LabelEv) => {
      if (!within(entry.at ?? entry.occurredAt ?? entry.day)) return false;
      if (!rule.filter) return true;
      const byId = rule.filter.labelId && lc(entry.label?.id) === lc(rule.filter.labelId);
      const byTitle =
        rule.filter.labelTitle && lc(entry.label?.title) === lc(rule.filter.labelTitle);
      return !!(byId || byTitle);
    };

    if (rule.event === "call") {
      for (const ev of calls) {
        if (lc(ev.dir) === "inbound") continue;
        if (!within(ev.at ?? ev.occurredAt ?? ev.day)) continue;
        const b = touch(ev.actor?.email);
        if (!b) continue;
        b.count += 1;
        const minutes = Math.max(0, Number(ev.ms ?? 0)) / 60000;
        b.minutes += Math.floor(minutes);
      }
    } else if (rule.event === "appointment") {
      for (const ev of appts) {
        if (!within(ev.at ?? ev.occurredAt ?? ev.day)) continue;
        const b = touch(ev.actor?.email);
        if (!b) continue;
        b.count += 1;
      }
    } else if (rule.event === "label") {
      for (const ev of labels) {
        if (!matchLabel(ev)) continue;
        const b = touch(ev.actor?.email);
        if (!b) continue;
        b.count += 1;
      }
    } else if (rule.event === "approval") {
      for (const ev of approvals) {
        if (!within(ev.at ?? ev.occurredAt ?? ev.day)) continue;
        if (rule.filter?.maker && lc(rule.filter.maker) !== lc(ev.maker)) continue;
        const b = touch(ev.actor?.email);
        if (!b) continue;
        b.count += 1;
      }
    } else if (rule.event === "sales") {
      for (const ev of sales) {
        if (!within(ev.at ?? ev.occurredAt ?? ev.day)) continue;
        if (rule.filter?.maker && lc(rule.filter.maker) !== lc(ev.maker)) continue;
        const b = touch(ev.actor?.email);
        if (!b) continue;
        const amount = Math.max(0, Number(ev.amount ?? 0));
        b.amount += Math.floor(amount);
        b.count += 1;
      }
    }

    for (const [email, value] of bucket) {
      const thresholds = rule.threshold ?? {};
      const meetsCount =
        thresholds.count == null ? true : value.count >= Math.max(0, thresholds.count);
      const meetsMinutes =
        thresholds.minutes == null ? true : value.minutes >= Math.max(0, thresholds.minutes);
      const meetsAmount =
        thresholds.amountYen == null ? true : value.amount >= Math.max(0, thresholds.amountYen);
      const meetsAll = meetsCount && meetsMinutes && meetsAmount;
      if (!meetsAll) continue;

      const dedupeKey = keyFor(rule, email, now);
      if (hasSeen(dedupeKey)) continue;
      markSeen(dedupeKey);

      const reward = rule.reward ?? {};
      await award(email, reward.xp ?? 0, reward.badge ?? rule.title);

      appendJsonl(path.join(EV_DIR, "trophies.jsonl"), {
        at: new Date().toISOString(),
        day: isoDay(now),
        tenant,
        rule: { id: rule.id, title: rule.title },
        actor: { email },
        summary: { count: value.count, minutes: value.minutes, amount: value.amount },
      });

      if (reward.chatwork) {
        try {
          await sendChatworkMessage(
            cwMakerAchievementText(email, rule.filter?.maker, value.count, value.amount)
          );
        } catch (err) {
          log(`[trophy] chatwork failed: ${(err as Error)?.message ?? err}`);
        }
      }
    }
  }
}
