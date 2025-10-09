// src/store/labels.ts
import fs from "fs";
import path from "path";

export type LabelItem = {
  id?: string;           // HubSpot ラベルID
  title?: string;        // ラベル名（テキスト一致用）
  category?: string;     // 例: "appointment" | "no_need" | "prospect_a" など自由
  enabled?: boolean;     // false で無効化
  xp?: number;           // 付与XP（0/未設定ならXPなし）
  badge?: string;        // Habiticaのバッジ/表示名（未指定ならカテゴリ名 or タイトル）
};

type LegacyDoc = { ids?: string[]; titles?: string[]; updatedAt?: string };
type LabelsDoc = {
  tenant: string;
  items: LabelItem[];    // 新形式（推奨）
  // 旧形式互換用
  ids?: string[];
  titles?: string[];
  updatedAt: string;
};

function fileOf(tenant: string) {
  const safe = (tenant || "default").replace(/[^\w.-]+/g, "_");
  const dir = path.join(process.cwd(), "data", "tenants", safe);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "labels.json");
}

function readDoc(tenant: string): LabelsDoc {
  const f = fileOf(tenant);
  if (!fs.existsSync(f)) {
    return { tenant, items: [], updatedAt: new Date().toISOString() };
  }
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8")) as Partial<LabelsDoc & LegacyDoc>;
    const items: LabelItem[] = Array.isArray((j as any).items) ? (j as any).items : [];
    const legacyIds = Array.isArray(j.ids) ? j.ids.map(String) : [];
    const legacyTitles = Array.isArray(j.titles) ? j.titles.map(String) : [];

    // 旧UIで保存された ids/titles は appointment として扱う（XP未設定）
    const merged: LabelItem[] = [
      ...items,
      ...legacyIds.map((id) => ({ id, category: "appointment" as const })),
      ...legacyTitles.map((title) => ({ title, category: "appointment" as const })),
    ];

    return {
      tenant,
      items: dedupeItems(merged),
      ids: j.ids || [],
      titles: j.titles || [],
      updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : new Date().toISOString(),
    };
  } catch {
    return { tenant, items: [], updatedAt: new Date().toISOString() };
  }
}

function writeDoc(doc: LabelsDoc) {
  const f = fileOf(doc.tenant);
  fs.writeFileSync(
    f,
    JSON.stringify(
      {
        tenant: doc.tenant,
        items: dedupeItems(doc.items || []),
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );
}

function dedupeItems(items: LabelItem[]): LabelItem[] {
  const seen = new Set<string>();
  const out: LabelItem[] = [];
  for (const it of items) {
    const key = `${(it.category || "appointment").toLowerCase()}|${(it.id || "").trim()}|${(it.title || "").trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: it.id ? String(it.id).trim() : undefined,
      title: it.title ? String(it.title).trim() : undefined,
      category: (it.category || "appointment").toLowerCase(),
      enabled: it.enabled !== false,
      xp: isFinite(Number(it.xp)) ? Math.max(0, Math.floor(Number(it.xp))) : undefined,
      badge: it.badge ? String(it.badge) : undefined,
    });
  }
  return out.slice(0, 2000);
}

export function setLabelItems(tenant: string, items: LabelItem[]) {
  const base = readDoc(tenant);
  base.items = dedupeItems(items || []);
  writeDoc(base);
}

export function setObservedLabels(tenant: string, ids: string[], titles: string[]) {
  const base = readDoc(tenant);
  const add: LabelItem[] = [
    ...ids.map((id) => ({ id, category: "appointment" as const })),
    ...titles.map((title) => ({ title, category: "appointment" as const })),
  ];
  base.items = dedupeItems([...(base.items || []), ...add]);
  writeDoc(base);
}

export function getLabelItems(tenant: string): LabelItem[] {
  return readDoc(tenant).items.filter((x) => x.enabled !== false);
}

export function getObservedLabelIds(tenant: string): string[] {
  return getLabelItems(tenant)
    .filter((x) => (x.category || "appointment").toLowerCase() === "appointment" && x.id)
    .map((x) => x.id!) as string[];
}

export function getObservedLabelTitles(tenant: string): string[] {
  return getLabelItems(tenant)
    .filter((x) => (x.category || "appointment").toLowerCase() === "appointment" && x.title)
    .map((x) => x.title!.toLowerCase());
}

export function getLabelItemsByCategory(tenant: string, category: string): LabelItem[] {
  const c = String(category || "").toLowerCase();
  return getLabelItems(tenant).filter((x) => (x.category || "appointment").toLowerCase() === c);
}
