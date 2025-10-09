// src/routes/labels.ts
import { Request, Response } from "express";
import { loadLabels, saveLabels, LabelItem } from "../store/labels.js";
import { log } from "../lib/utils.js";

export async function labelsGet(req: Request, res: Response) {
  try {
    const tenant = String(req.params.id || "default");
    const doc = await loadLabels(tenant);
    return res.json({ ok: true, tenant, ...doc });
  } catch (e: any) {
    log(`[labels.get] ${e?.message || String(e)}`);
    return res.status(500).json({ ok: false, error: "server" });
  }
}

export async function labelsPut(req: Request, res: Response) {
  try {
    const tenant = String(req.params.id || "default");
    const body = (req as any).body || {};
    if (!body || !Array.isArray(body.items)) {
      return res.status(400).json({ ok: false, error: "bad_body" });
    }
    const items = body.items as LabelItem[];
    const doc = await saveLabels(tenant, items);
    return res.json({ ok: true, tenant, ...doc });
  } catch (e: any) {
    log(`[labels.put] ${e?.message || String(e)}`);
    return res.status(500).json({ ok: false, error: "server" });
  }
}
