// src/routes/labels.ts
import { Request, Response } from "express";
import {
  getLabelItems,
  setLabelItems,
  setObservedLabels,
  getObservedLabelIds,
  getObservedLabelTitles,
  LabelItem,
} from "../store/labels.js";

/** GET /tenant/:id/labels  */
export async function labelsGet(req: Request, res: Response) {
  try {
    const tenant = String(req.params.id || "default");
    const items = getLabelItems(tenant);
    const ids = getObservedLabelIds(tenant);       // 互換: appointment のみ
    const titles = getObservedLabelTitles(tenant); // 互換: appointment のみ
    res.json({ tenant, items, ids, titles });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

/** PUT /tenant/:id/labels
 * 受領:
 *  - items?: {id?, title?, category?, enabled?, xp?, badge?}[]
 *  - ids?: string[] | "a,b,c"
 *  - titles?: string[] | "x,y,z"
 * items が来た場合は新形式として全置換。なければ ids/titles を appointment 追加として扱う。
 */
export async function labelsPut(req: Request, res: Response) {
  try {
    const tenant = String(req.params.id || "default");
    const b: any = req.body || {};

    const toArray = (v: any): string[] => {
      if (Array.isArray(v)) return v.map(String);
      if (typeof v === "string")
        return v.split(/[,;\n]/g).map((s) => s.trim()).filter(Boolean);
      return [];
    };

    if (Array.isArray(b.items)) {
      const items: LabelItem[] = (b.items as any[]).map((r) => ({
        id: r?.id ? String(r.id).trim() : undefined,
        title: r?.title ? String(r.title).trim() : undefined,
        category: (r?.category || "appointment").toLowerCase(),
        enabled: r?.enabled !== false,
        xp: isFinite(Number(r?.xp)) ? Math.max(0, Math.floor(Number(r.xp))) : undefined,
        badge: r?.badge ? String(r.badge) : undefined,
      }));
      setLabelItems(tenant, items);
      return res.json({ ok: true, tenant, items });
    }

    const ids = toArray(b.ids);
    const titles = toArray(b.titles);
    if (ids.length === 0 && titles.length === 0) {
      return res.status(400).json({ ok: false, error: "items or ids/titles required" });
    }
    setObservedLabels(tenant, ids, titles);
    res.json({ ok: true, tenant, ids, titles });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
