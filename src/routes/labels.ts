import { Request, Response } from "express";
import { getObservedLabels, setObservedLabels } from "../store/labels.js";

export function labelsGet(req: Request, res: Response) {
  const tenant = String(req.params.id || "default");
  res.json({ tenant, labels: getObservedLabels(tenant) });
}

export function labelsPut(req: Request, res: Response) {
  const tenant = String(req.params.id || "default");
  const body = (req as any).body || {};
  if (!Array.isArray(body?.labels)) {
    return res.status(400).json({ error: "labels must be an array" });
  }
  setObservedLabels(tenant, body.labels);
  res.json({ ok: true });
}
