import { randomUUID } from "crypto";
import { readAll, tenantJsonlPath, upsertById } from "./jsonl.js";

export interface AwardedRecord {
  id: string;
  tenantId: string;
  badgeId: string;
  userId: string;
  at: string;
}

const FILENAME = "awarded.jsonl";

function nowIso(): string {
  return new Date().toISOString();
}

async function listAwarded(tenant: string): Promise<AwardedRecord[]> {
  const file = tenantJsonlPath(tenant, FILENAME);
  return readAll<AwardedRecord>(file);
}

export async function hasAwarded(
  tenant: string,
  badgeId: string,
  userId: string
): Promise<boolean> {
  const records = await listAwarded(tenant);
  return records.some((record) => record.badgeId === badgeId && record.userId === userId);
}

export async function markAwarded(
  tenant: string,
  badgeId: string,
  userId: string
): Promise<AwardedRecord> {
  const record: AwardedRecord = {
    id: randomUUID(),
    tenantId: tenant,
    badgeId,
    userId,
    at: nowIso(),
  };
  await upsertById<AwardedRecord>(tenantJsonlPath(tenant, FILENAME), record);
  return record;
}

export async function listAwardedForUser(
  tenant: string,
  userId: string
): Promise<AwardedRecord[]> {
  const records = await listAwarded(tenant);
  return records.filter((record) => record.userId === userId);
}
