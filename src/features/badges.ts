import type { Badge } from "../types/ops.js";
import { BADGE_CHECK_ON_EVENTS } from "../lib/env.js";
import { log } from "../lib/utils.js";
import { listBadges } from "../store/badges.js";
import { hasAwarded, markAwarded } from "../store/awarded.js";
import { adjustUserStats, awardBadgeItem } from "../connectors/habitica.js";
import { readAll, tenantJsonlPath } from "../store/jsonl.js";
import type { XpAdjustment } from "../types/ops.js";

export type BadgeEventType = "call" | "appointment" | "manualAdjust";

export interface BadgeEvent {
  type: BadgeEventType;
  metrics: Record<string, number>;
  labels?: string[];
}

async function estimateTotalXp(
  tenantId: string,
  userId: string,
  metrics: Record<string, number>
): Promise<number | null> {
  if (Number.isFinite(metrics.totalXp)) return Number(metrics.totalXp);
  if (Number.isFinite(metrics.cumulativeXp)) return Number(metrics.cumulativeXp);
  const file = tenantJsonlPath(tenantId, "adjustments.jsonl");
  const adjustments = await readAll<XpAdjustment>(file);
  let total = 0;
  for (const adj of adjustments) {
    if (adj?.userId === userId && Number.isFinite(adj?.deltaXp)) {
      total += Number(adj.deltaXp);
    }
  }
  if (Number.isFinite(metrics.deltaXp)) total += Number(metrics.deltaXp);
  return total;
}

function meetsCriteria(
  badge: Badge,
  metrics: Record<string, number>,
  labels: string[] | undefined,
  totalXp: number | null
): boolean {
  const threshold = Number(badge.criteria.threshold);
  switch (badge.criteria.type) {
    case "totalXpAtLeast":
      if (totalXp == null) return false;
      return totalXp >= threshold;
    case "callsDurationMsAtLeast": {
      const value =
        Number(metrics.totalCallDurationMs) ||
        Number(metrics.callsDurationMs) ||
        Number(metrics.callDurationMs) ||
        0;
      return value >= threshold;
    }
    case "appointmentsCountAtLeast": {
      const value =
        Number(metrics.appointmentsCount) ||
        Number(metrics.appointments) ||
        Number(metrics.deltaAppointments) ||
        0;
      return value >= threshold;
    }
    case "hasLabelCountAtLeast": {
      if (!badge.criteria.labelId) return false;
      const list = Array.isArray(labels) ? labels : [];
      const count = list.filter((label) => label === badge.criteria.labelId).length;
      return count >= threshold;
    }
    default:
      return false;
  }
}

export async function checkAndAwardBadges(
  tenantId: string,
  userId: string,
  event: BadgeEvent
): Promise<void> {
  if (!BADGE_CHECK_ON_EVENTS) return;
  try {
    const badges = await listBadges(tenantId);
    if (!badges.length) return;
    const active = badges.filter((badge) => badge.active !== false);
    if (!active.length) return;

    const totalXp = await estimateTotalXp(tenantId, userId, event.metrics);

    for (const badge of active) {
      try {
        const already = await hasAwarded(tenantId, badge.id, userId);
        if (already) continue;
        if (!meetsCriteria(badge, event.metrics, event.labels, totalXp)) continue;

        await awardBadgeItem(userId, badge);
        if (Number.isFinite(badge.xp)) {
          await adjustUserStats(tenantId, userId, Number(badge.xp));
        }
        await markAwarded(tenantId, badge.id, userId);
        log(
          `[badge] awarded badge=${badge.id} tenant=${tenantId} user=${userId} event=${event.type}`
        );
      } catch (err: any) {
        log(`[badge] award error badge=${badge.id} user=${userId} err=${err?.message || err}`);
      }
    }
  } catch (err: any) {
    log(`[badge] check error tenant=${tenantId} user=${userId} err=${err?.message || err}`);
  }
}
