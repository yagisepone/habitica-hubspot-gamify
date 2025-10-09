// src/store/labels.ts
import { promises as fs } from "fs";
import path from "path";
import { APPOINTMENT_VALUES } from "../lib/env.js";

export type LabelItem = {
  id: string;           // HubSpot ラベルID（必須）
  title: string;        // 表示名（必須）
  enabled?: boolean;    // 監視を有効化するか
  xp?: number;          // このアウトカムで付与するXP（任意）
  badge?: string;       // Habiticaに付けるバッジ名（任意）
};

type LabelDoc = { items: LabelItem[]; updatedAt: string };

const MEM = new Map<string, LabelDoc>(); // tenant -> doc

function fileOf(tenant: string) {
  return path.join("data", "tenants", tenant, "labels.json");
}

async function ensureDirFor(file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
}

async function readJSON<T>(file: string): Promise<T | null> {
  try {
    const s = await fs.readFile(file, "utf8");
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

async function writeJSON(file: string, obj: any) {
  await ensureDirFor(file);
  await fs.writeFile(file, JSON.stringify(obj, null, 2), "utf8");
}

function fallbackFromEnv(): LabelDoc {
  // 既定：env.APPOINTMENT_VALUES を有効化し、タイトルは同名
  const items = (APPOINTMENT_VALUES || []).map((k) => ({
    id: k,
    title: k,
    enabled: true,
    xp: undefined,
    badge: undefined,
  }));
  return { items, updatedAt: new Date().toISOString() };
}

export async function loadLabels(tenant: string): Promise<LabelDoc> {
  if (MEM.has(tenant)) return MEM.get(tenant)!;
  const file = fileOf(tenant);
  const j = await readJSON<LabelDoc>(file);
  const doc = j ?? fallbackFromEnv();
  MEM.set(tenant, doc);
  return doc;
}

export async function saveLabels(tenant: string, items: LabelItem[]) {
  const cleaned = (items || [])
    .filter((x) => x && String(x.id || "").trim() && String(x.title || "").trim())
    .map((x) => ({
      id: String(x.id).trim(),
      title: String(x.title).trim(),
      enabled: !!x.enabled,
      xp: Number.isFinite(Number(x.xp)) ? Number(x.xp) : undefined,
      badge: x.badge ? String(x.badge) : undefined,
    }));
  const doc: LabelDoc = { items: cleaned, updatedAt: new Date().toISOString() };
  MEM.set(tenant, doc);
  await writeJSON(fileOf(tenant), doc);
  return doc;
}

/** 観測用: 有効なID一覧 */
export async function getObservedLabelIds(tenant: string): Promise<string[]> {
  const { items } = await loadLabels(tenant);
  return items.filter((x) => x.enabled).map((x) => x.id);
}

/** 表示用: ID -> タイトル の対応表 */
export async function getObservedLabelTitles(tenant: string): Promise<Record<string, string>> {
  const { items } = await loadLabels(tenant);
  const m: Record<string, string> = {};
  for (const it of items) m[it.id] = it.title;
  return m;
}

/** XP/バッジ取得: 該当IDの設定があれば返す */
export async function lookupXpConfig(tenant: string, id: string): Promise<{
  xp?: number;
  badge?: string;
} | undefined> {
  const { items } = await loadLabels(tenant);
  const hit = items.find((x) => x.id === id && x.enabled);
  if (!hit) return undefined;
  return { xp: hit.xp, badge: hit.badge };
}
