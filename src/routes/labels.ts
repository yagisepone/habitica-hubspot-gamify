// src/routes/labels.ts
import type { Request, Response } from "express";
import { readLabels, writeLabels } from "../store/labels.js";

const safeTenant = (t: string | undefined) =>
  String(t || "default").trim() || "default";

export async function labelsGet(req: Request, res: Response) {
  const tenant = safeTenant(req.params.id);
  const data = await readLabels(tenant);
  res.json(data);
}

export async function labelsPut(req: Request, res: Response) {
  const tenant = safeTenant(req.params.id);
  const body = req.body || {};
  const saved = await writeLabels(tenant, body);
  res.json(saved);
}
