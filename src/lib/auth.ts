import type { NextFunction, Request, Response } from "express";

export type AnyReq = Request & {
  params?: Record<string, any>;
  query?: Record<string, any>;
};

export function tenantFrom(req: AnyReq): string {
  const params = req.params || {};
  const tenant =
    params.id ??
    params.tenant ??
    req.query?.tenant ??
    "default";
  return String(tenant || "default").trim() || "default";
}

export function getTokenFromHeaders(req: AnyReq): string {
  const raw = req.get("authorization") || req.get("x-authorization") || "";
  return raw.replace(/^Bearer\s+/i, "").trim();
}

function readTokenMap(): Record<string, string> {
  try {
    return JSON.parse(process.env.SGC_TOKENS || "{}");
  } catch {
    return {};
  }
}

export function requireEditorToken(req: Request, res: Response, next: NextFunction) {
  const tokenMap = readTokenMap();
  const tenant = tenantFrom(req);
  const token = getTokenFromHeaders(req);
  const expected = tokenMap[tenant] || tokenMap["*"];
  if (!expected) {
    return res.status(401).json({ ok: false, error: "no-token-config" });
  }
  if (token !== expected) {
    return res.status(401).json({ ok: false, error: "bad-token" });
  }
  next();
}
