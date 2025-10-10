// src/store/labels.ts
import path from "path";
import { promises as fs } from "fs";

type LabelItem = {
  id?: string;
  title?: string;
  category?: string; // "appointment" | "label"
  enabled?: boolean;
  xp?: number;
  badge?: string;
};

type LabelsFile = { items?: LabelItem[] };

const LABELS_DIR = path.resolve("data/labels");

async function ensureDir() {
  await fs.mkdir(LABELS_DIR, { recursive: true }).catch(() => {});
}
const safeTenant = (t: string | undefined) =>
  String(t || "default").trim() || "default";

export async function readLabels(tenant: string): Promise<LabelsFile> {
  await ensureDir();
  const file = path.resolve(LABELS_DIR, `${safeTenant(tenant)}.json`);
  try {
    const txt = await fs.readFile(file, "utf8");
    const j = JSON.parse(txt || "{}");
    if (Array.isArray(j.items)) return { items: j.items };
  } catch {}
  return { items: [] };
}

export async function writeLabels(
  tenant: string,
  body: LabelsFile
): Promise<LabelsFile> {
  await ensureDir();
  const file = path.resolve(LABELS_DIR, `${safeTenant(tenant)}.json`);
  const items = Array.isArray(body?.items) ? body.items : [];
  const norm = items.map((it) => ({
    id: it?.id ? String(it.id) : undefined,
    title: it?.title ? String(it.title) : undefined,
    category: it?.category ? String(it.category) : undefined,
    enabled: it?.enabled !== false,
    xp:
      Number.isFinite(Number(it?.xp)) && Number(it?.xp) >= 0
        ? Math.floor(Number(it?.xp))
        : undefined,
    badge: it?.badge ? String(it.badge) : undefined,
  }));
  const out: LabelsFile = { items: norm };
  await fs.writeFile(file, JSON.stringify(out, null, 2));
  return out;
}

/** UI/appointment.ts から使う：items配列のみ取得 */
export async function getLabelItems(tenant: string): Promise<LabelItem[]> {
  const data = await readLabels(tenant);
  return Array.isArray(data.items) ? data.items : [];
}

/** 既存の「観測」系（ダッシュボード等が期待しているなら残す） */
const OBS_DIR = path.resolve("data/observed");
export async function getObservedLabelIds(tenant: string): Promise<string[]> {
  await fs.mkdir(OBS_DIR, { recursive: true }).catch(() => {});
  try {
    const p = path.resolve(OBS_DIR, `${safeTenant(tenant)}-ids.json`);
    const txt = await fs.readFile(p, "utf8");
    const j = JSON.parse(txt || "[]");
    return Array.isArray(j) ? j.map((x: any) => String(x)) : [];
  } catch {
    return [];
  }
}
export async function getObservedLabelTitles(
  tenant: string
): Promise<string[]> {
  await fs.mkdir(OBS_DIR, { recursive: true }).catch(() => {});
  try {
    const p = path.resolve(OBS_DIR, `${safeTenant(tenant)}-titles.json`);
    const txt = await fs.readFile(p, "utf8");
    const j = JSON.parse(txt || "[]");
    return Array.isArray(j) ? j.map((x: any) => String(x)) : [];
  } catch {
    return [];
  }
}
