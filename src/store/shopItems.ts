import { randomUUID } from "crypto";
import { ShopItem } from "../types/ops.js";
import { readAll, removeById, tenantJsonlPath, upsertById } from "./jsonl.js";

function nowIso(): string {
  return new Date().toISOString();
}

export interface ShopItemInput {
  id?: string;
  name: string;
  description?: string;
  value: number;
  isPaid?: boolean;
  active?: boolean;
}

const FILENAME = "items.jsonl";

async function normalizeList(items: ShopItem[]): Promise<ShopItem[]> {
  return items
    .map((item) => ({
      ...item,
      active: item.active !== false,
      isPaid: item.isPaid === true,
    }))
    .sort((a, b) => {
      const aTs = Date.parse(a.createdAt || "") || 0;
      const bTs = Date.parse(b.createdAt || "") || 0;
      return aTs - bTs;
    });
}

export async function listShopItems(tenant: string): Promise<ShopItem[]> {
  const file = tenantJsonlPath(tenant, FILENAME);
  const items = await readAll<ShopItem>(file);
  return normalizeList(items);
}

export async function upsertShopItem(
  tenant: string,
  input: ShopItemInput
): Promise<ShopItem> {
  const file = tenantJsonlPath(tenant, FILENAME);
  const all = await listShopItems(tenant);
  const id = input.id || randomUUID();
  const existing = all.find((item) => item.id === id);
  const now = nowIso();
  const payload: ShopItem = {
    id,
    name: String(input.name).trim(),
    description: input.description ? String(input.description).trim() || undefined : undefined,
    value: Math.trunc(Number(input.value)),
    isPaid: input.isPaid === true,
    active: input.active === undefined ? existing?.active ?? true : input.active !== false,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await upsertById<ShopItem>(file, payload);
  return payload;
}

export async function setShopItemActive(
  tenant: string,
  id: string,
  active: boolean
): Promise<ShopItem | null> {
  const file = tenantJsonlPath(tenant, FILENAME);
  const all = await listShopItems(tenant);
  const existing = all.find((item) => item.id === id);
  if (!existing) return null;
  const payload: ShopItem = {
    ...existing,
    active,
    updatedAt: nowIso(),
  };
  await upsertById<ShopItem>(file, payload);
  return payload;
}

export async function deleteShopItem(
  tenant: string,
  id: string,
  opts?: { hard?: boolean }
): Promise<void> {
  const file = tenantJsonlPath(tenant, FILENAME);
  if (opts?.hard) {
    await removeById(file, id);
    return;
  }
  await setShopItemActive(tenant, id, false);
}
