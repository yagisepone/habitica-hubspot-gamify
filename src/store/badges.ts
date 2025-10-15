import { randomUUID } from "crypto";
import { Badge } from "../types/ops.js";
import { readAll, removeById, tenantJsonlPath, upsertById } from "./jsonl.js";

const FILENAME = "badges.jsonl";

const nowIso = () => new Date().toISOString();

export interface BadgeInput {
  id?: string;
  title: string;
  description?: string;
  xp?: number;
  icon?: string;
  criteria: Badge["criteria"];
  active?: boolean;
}

export async function listBadges(tenant: string): Promise<Badge[]> {
  const file = tenantJsonlPath(tenant, FILENAME);
  const items = await readAll<Badge>(file);
  return items
    .map((badge) => ({
      ...badge,
      active: badge.active !== false,
    }))
    .sort((a, b) => {
      const aTs = Date.parse(a.createdAt || "") || 0;
      const bTs = Date.parse(b.createdAt || "") || 0;
      return aTs - bTs;
    });
}

export async function upsertBadge(tenant: string, input: BadgeInput): Promise<Badge> {
  const id = input.id || randomUUID();
  const existing = (await listBadges(tenant)).find((badge) => badge.id === id);
  const now = nowIso();
  const payload: Badge = {
    id,
    title: String(input.title).trim(),
    description: input.description ? String(input.description).trim() || undefined : undefined,
    xp: Number.isFinite(Number(input.xp)) ? Number(input.xp) : existing?.xp,
    icon: input.icon ? String(input.icon).trim() || undefined : existing?.icon,
    criteria: {
      type: input.criteria.type,
      threshold: Number(input.criteria.threshold),
      labelId: input.criteria.labelId ? String(input.criteria.labelId).trim() || undefined : undefined,
    },
    active: input.active === undefined ? existing?.active ?? true : input.active !== false,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await upsertById<Badge>(tenantJsonlPath(tenant, FILENAME), payload);
  return payload;
}

export async function setBadgeActive(
  tenant: string,
  id: string,
  active: boolean
): Promise<Badge | null> {
  const existing = (await listBadges(tenant)).find((badge) => badge.id === id);
  if (!existing) return null;
  const payload: Badge = {
    ...existing,
    active,
    updatedAt: nowIso(),
  };
  await upsertById<Badge>(tenantJsonlPath(tenant, FILENAME), payload);
  return payload;
}

export async function deleteBadge(
  tenant: string,
  id: string,
  opts?: { hard?: boolean }
): Promise<void> {
  if (opts?.hard) {
    await removeById(tenantJsonlPath(tenant, FILENAME), id);
    return;
  }
  await setBadgeActive(tenant, id, false);
}
