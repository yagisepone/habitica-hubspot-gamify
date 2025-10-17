// NEW
import type { Request, Response, NextFunction } from "express";
import { rulesGet, rulesPut } from "./rules.js";
import { runTrophyAggregation } from "../features/trophies.js";
import { requireEditorToken } from "../lib/auth.js";

function ensureTenant(req: Request): string {
  const tenant = String(req.params?.id ?? "default").trim() || "default";
  if (!req.params) (req as any).params = {};
  (req.params as any).id = tenant;
  return tenant;
}

async function getRulesSnapshot(req: Request): Promise<any> {
  let payload: any;
  const fakeRes = {
    json: (data: any) => {
      payload = data;
      return data;
    },
  } as Response;
  await rulesGet(req, fakeRes);
  return payload ?? {};
}

function ensureEditor(req: Request, res: Response): boolean {
  let allowed = false;
  const next: NextFunction = () => {
    allowed = true;
  };
  requireEditorToken(req, res, next);
  return allowed;
}

export async function trophiesGet(req: Request, res: Response) {
  ensureTenant(req);
  const rules = await getRulesSnapshot(req);
  res.json(Array.isArray(rules?.trophies) ? rules.trophies : []);
}

export async function trophiesPut(req: Request, res: Response) {
  if (!ensureEditor(req, res)) return;
  ensureTenant(req);
  const rules = await getRulesSnapshot(req);
  const trophies = Array.isArray(req.body) ? req.body : [];
  const nextReq = req as Request & { body: any };
  nextReq.body = { ...rules, trophies };

  let payload: any;
  const fakeRes = {
    json: (data: any) => {
      payload = data;
      return data;
    },
  } as Response;
  await rulesPut(nextReq, fakeRes);
  res.json(Array.isArray(payload?.trophies) ? payload.trophies : []);
}

export async function trophiesRun(req: Request, res: Response) {
  if (!ensureEditor(req, res)) return;
  const tenant = ensureTenant(req);
  const rules = await getRulesSnapshot(req);
  await runTrophyAggregation(tenant, Array.isArray(rules?.trophies) ? rules.trophies : []);
  res.json({ ok: true });
}
