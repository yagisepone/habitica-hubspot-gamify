import express, { type NextFunction, type Request, type Response } from "express";
import path from "path";
import { randomUUID } from "crypto";

import { requireEditorToken, tenantFrom } from "../lib/auth.js";
import type { AnyReq } from "../lib/auth.js";
import { log } from "../lib/utils.js";
import {
  appendJsonl,
  ensureTenantDir,
  readJson,
  readLastN,
  writeJson,
} from "../store/ops.js";
import { writeLabels } from "../store/labels.js";
import type {
  AuditEvent,
  LegacyShopItem,
  ManualLogEntry,
  OpsLogEntry,
  XpAdjustment,
} from "../types/ops.js";

export const opsRouter = express.Router();
export const opsApiRouter = express.Router();
const jsonParser = express.json({ limit: "1mb" });

const MAX_LIMIT = 500;

function clampLimit(value: unknown, def: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return def;
  return Math.min(Math.max(1, Math.floor(num)), MAX_LIMIT);
}

function actorFrom(req: Request): string {
  const headers = [
    "x-actor",
    "x-operator",
    "x-editor",
    "x-editor-name",
    "x-user-name",
  ];
  for (const key of headers) {
    const v = req.get(key);
    if (v && v.trim()) return v.trim();
  }
  return "api";
}

function normalizeShopItems(items: any[]): LegacyShopItem[] {
  if (!Array.isArray(items)) return [];
  const norm: LegacyShopItem[] = [];
  for (const raw of items) {
    const title = String(raw?.title ?? raw?.name ?? "").trim();
    const price = Number(raw?.priceXp);
    if (!title) {
      throw new Error("title-required");
    }
    if (!Number.isFinite(price) || price <= 0 || !Number.isInteger(price)) {
      throw new Error("price-invalid");
    }
    const stockVal = raw?.stock;
    let stock: number | null | undefined = undefined;
    if (stockVal === null || stockVal === undefined || stockVal === "") {
      stock = null;
    } else {
      const n = Number(stockVal);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        throw new Error("stock-invalid");
      }
      stock = Math.floor(n);
    }
    const item: LegacyShopItem = {
      id: String(raw?.id ?? "") || randomUUID(),
      title,
      priceXp: Number(price),
      badgeOnBuy: raw?.badgeOnBuy ? String(raw.badgeOnBuy).trim() || undefined : undefined,
      stock,
      enabled: raw?.enabled === false ? false : true,
    };
    norm.push(item);
  }
  return norm;
}

function enrichItemsForResponse(items: LegacyShopItem[]): LegacyShopItem[] {
  return items.map((item) => ({
    ...item,
    name: item.title,
    enabled: item.enabled !== false,
    stock:
      item.stock === null || item.stock === undefined ? item.stock : Math.max(0, item.stock),
  }));
}

function adjustmentsPath(dir: string) {
  return path.join(dir, "adjustments.jsonl");
}
function shopPath(dir: string) {
  return path.join(dir, "shop.json");
}
function auditPath(dir: string) {
  return path.join(dir, "audit.jsonl");
}
function manualPath(dir: string) {
  return path.join(dir, "manual.jsonl");
}

function tenantId(req: Request): string {
  return tenantFrom(req as AnyReq);
}

function mapTenantParam(req: Request, _res: Response, next: NextFunction) {
  if ((req.params as any)?.tenant && !(req.params as any).id) {
    (req.params as any).id = (req.params as any).tenant;
  }
  next();
}

function normalizeUserId(raw: any): string | null {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).trim();
  return v ? v : null;
}

function normalizeReason(raw: any): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  return text.length > 512 ? text.slice(0, 512) : text;
}

function normalizeDelta(value: any, min: number, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const clamped = Math.trunc(num);
  if (clamped < min || clamped > max) return null;
  return clamped;
}

function parseBulkLabelItems(payload: any): any[] {
  if (Array.isArray(payload?.items)) return payload.items;
  const text =
    typeof payload?.text === "string"
      ? payload.text
      : typeof payload?.csv === "string"
      ? payload.csv
      : typeof payload?.tsv === "string"
      ? payload.tsv
      : "";
  if (!text.trim()) return [];
  const lines = text
    .split(/\r?\n/)
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0);
  if (!lines.length) return [];
  const delimiter = lines.some((line: string) => line.includes("\t")) ? "\t" : ",";
  const items = [];
  for (const line of lines) {
    const cols = line.split(delimiter).map((segment: string) => segment.trim());
    if (!cols[0]) continue;
    const xp = cols[2] ? Number(cols[2]) : undefined;
    items.push({
      id: cols[0],
      title: cols[1] || "",
      xp: Number.isFinite(xp) ? xp : undefined,
      badge: cols[3] || undefined,
    });
  }
  return items;
}

function ensureTenantFromBody(req: Request, _res: Response, next: NextFunction) {
  const bodyTenant = (req.body && typeof (req.body as any).tenant === "string") ? String((req.body as any).tenant).trim() : "";
  if (bodyTenant) {
    (req.query as Record<string, any>).tenant = bodyTenant;
  }
  next();
}

type ManualPayload = {
  userId: string;
  userName?: string;
  deltaXp: number;
  badge?: string;
  note?: string;
};

function extractManualPayload(body: any): ManualPayload {
  const userId = String(body?.userId ?? "").trim();
  if (!userId) {
    throw new Error("userId-required");
  }
  const deltaSrc = body?.delta ?? body?.deltaXp;
  const delta = Number(deltaSrc);
  if (!Number.isFinite(delta)) {
    throw new Error("deltaXp-invalid");
  }
  const deltaXp = Math.trunc(delta);
  const userName = String(body?.userName ?? "").trim();
  const badge = String(body?.badge ?? "").trim();
  const note = String(body?.note ?? body?.reason ?? "").trim();
  return {
    userId,
    userName: userName ? userName : undefined,
    deltaXp,
    badge: badge ? badge : undefined,
    note: note ? note : undefined,
  };
}

async function listAdjustments(
  tenant: string,
  limit: number,
  userIdFilter?: string | null
): Promise<XpAdjustment[]> {
  const dir = await ensureTenantDir(tenant);
  const items = await readLastN(adjustmentsPath(dir), limit);
  const filtered = userIdFilter
    ? items.filter((item) => String(item?.userId || "") === userIdFilter)
    : items;
  return filtered.slice(0, limit) as XpAdjustment[];
}

async function recordAdjustment(
  tenant: string,
  payload: ManualPayload & { source: XpAdjustment["source"] },
  req: Request,
  auditMeta: { action: AuditEvent["action"]; detail?: (adjustment: XpAdjustment) => Record<string, any> }
): Promise<XpAdjustment> {
  const dir = await ensureTenantDir(tenant);
  const adjustment: XpAdjustment = {
    id: randomUUID(),
    tenant,
    userId: payload.userId,
    userName: payload.userName,
    deltaXp: payload.deltaXp,
    badge: payload.badge,
    note: payload.note,
    source: payload.source,
    createdAt: new Date().toISOString(),
  };
  await appendJsonl(adjustmentsPath(dir), adjustment);

  const audit: AuditEvent = {
    id: randomUUID(),
    tenant,
    actor: actorFrom(req),
    action: auditMeta.action,
    detail: auditMeta.detail ? auditMeta.detail(adjustment) : undefined,
    ip: req.ip,
    ua: req.get("user-agent") || undefined,
    at: new Date().toISOString(),
  };
  await appendJsonl(auditPath(dir), audit);
  return adjustment;
}

async function processPurchase(
  tenant: string,
  body: any,
  req: Request
): Promise<{ adjustment: XpAdjustment; newStock: number | null }> {
  const userId = String(body?.userId ?? "").trim();
  if (!userId) {
    throw new Error("userId-required");
  }
  const itemId = String(body?.itemId ?? "").trim();
  if (!itemId) {
    throw new Error("itemId-required");
  }
  const quantity = Number.isFinite(Number(body?.qty))
    ? Math.max(1, Math.floor(Number(body?.qty)))
    : 1;

  const userNameVal = String(body?.userName ?? "").trim();
  const dir = await ensureTenantDir(tenant);
  const shopFile = shopPath(dir);
  const currentItems = normalizeShopItems(await readJson<LegacyShopItem[]>(shopFile, []));
  const item = currentItems.find((it) => it.id === itemId);
  if (!item) {
    throw new Error("item-not-found");
  }
  if (item.enabled === false) {
    throw new Error("item-disabled");
  }
  if (item.stock != null) {
    if (item.stock < quantity) {
      throw new Error("stock-shortage");
    }
    item.stock -= quantity;
    if (item.stock < 0) item.stock = 0;
  }

  const deltaXp = -Math.abs(item.priceXp) * quantity;
  const note = `shop:${item.title} x${quantity}`;

  await writeJson(shopFile, currentItems);
  const adjustment = await recordAdjustment(
    tenant,
    {
      userId,
      userName: userNameVal ? userNameVal : undefined,
      deltaXp,
      badge: item.badgeOnBuy ? String(item.badgeOnBuy).trim() || undefined : undefined,
      note,
      source: "shop",
    },
    req,
    {
      action: "shop.purchase",
      detail: (adj) => ({
        itemId: item.id,
        title: item.title,
        qty: quantity,
        userId: adj.userId,
        deltaXp: adj.deltaXp,
        newStock: item.stock ?? null,
      }),
    }
  );

  return { adjustment, newStock: item.stock ?? null };
}

function toOpsLogEntry(tenant: string, item: any): OpsLogEntry | null {
  if (!item || typeof item !== "object") return null;
  const delta = Number((item as any).deltaXp ?? (item as any).delta ?? NaN);
  if (!Number.isFinite(delta)) return null;
  const createdAt =
    (item as any).createdAt ||
    (item as any).ts ||
    (item as any).at ||
    new Date().toISOString();
  const sourceRaw = (item as any).source || "";
  const type: OpsLogEntry["type"] = sourceRaw === "shop" ? "purchase" : "adjust";
  const noteRaw = (item as any).note;
  const badgeRaw = (item as any).badge;
  return {
    id: String((item as any).id ?? randomUUID()),
    tenant,
    type,
    ts: String(createdAt),
    userId: String((item as any).userId ?? ""),
    userName: (item as any).userName ? String((item as any).userName) : undefined,
    deltaXp: Math.trunc(delta),
    badge: badgeRaw ? String(badgeRaw) : undefined,
    note: noteRaw ? String(noteRaw) : undefined,
    source: sourceRaw ? String(sourceRaw) : type,
  };
}

opsRouter.get("/:id/adjustments", async (req: Request, res: Response) => {
  try {
    const tenant = tenantId(req);
    const limit = clampLimit(req.query?.limit, 100);
    const userIdFilter = req.query?.userId ? String(req.query.userId) : null;
    const items = await listAdjustments(tenant, limit, userIdFilter);
    res.json({ items });
  } catch (err: any) {
    log(`[ops] adjustments.get error: ${err?.message || err}`);
    res.status(500).json({ ok: false, error: "internal-error" });
  }
});

opsRouter.post(
  "/:id/adjustments",
  requireEditorToken,
  jsonParser,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantId(req);
      let payload: ManualPayload;
      try {
        payload = extractManualPayload(req.body);
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (msg === "userId-required") {
          return res.status(400).json({ ok: false, error: "userId-required" });
        }
        if (msg === "deltaXp-invalid") {
          return res.status(400).json({ ok: false, error: "deltaXp-invalid" });
        }
        throw err;
      }
      const adjustment = await recordAdjustment(
        tenant,
        { ...payload, source: "manual" },
        req,
        {
          action: "adjust.create",
          detail: (adj) => ({
            id: adj.id,
            userId: adj.userId,
            deltaXp: adj.deltaXp,
            badge: adj.badge,
            note: adj.note,
          }),
        }
      );
      res.json({ ok: true, id: adjustment.id, createdAt: adjustment.createdAt });
    } catch (err: any) {
      log(`[ops] adjustments.post error: ${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

opsRouter.get("/:id/shop/items", async (req: Request, res: Response) => {
  try {
    const tenant = tenantId(req);
    const dir = await ensureTenantDir(tenant);
    const items = await readJson<LegacyShopItem[]>(shopPath(dir), []);
    res.json({ items: enrichItemsForResponse(normalizeShopItems(items)) });
  } catch (err: any) {
    log(`[ops] shop.items.get error: ${err?.message || err}`);
    res.status(500).json({ ok: false, error: "internal-error" });
  }
});

opsRouter.put(
  "/:id/shop/items",
  requireEditorToken,
  jsonParser,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantId(req);
      const dir = await ensureTenantDir(tenant);
      const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
      const items = normalizeShopItems(rawItems);
      await writeJson(shopPath(dir), items);

      const audit: AuditEvent = {
        id: randomUUID(),
        tenant,
        actor: actorFrom(req),
        action: "shop.item.put",
        detail: { count: items.length },
        ip: req.ip,
        ua: req.get("user-agent") || undefined,
        at: new Date().toISOString(),
      };
      await appendJsonl(auditPath(dir), audit);
      res.json({ ok: true, count: items.length });
    } catch (err: any) {
      if (err instanceof Error && err.message.endsWith("required")) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      if (err instanceof Error && err.message.endsWith("invalid")) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      log(`[ops] shop.items.put error: ${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

opsRouter.post(
  "/:id/shop/purchase",
  requireEditorToken,
  jsonParser,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantId(req);
      try {
        const { adjustment, newStock } = await processPurchase(tenant, req.body, req);
        res.json({
          ok: true,
          newStock,
          adjustmentId: adjustment.id,
        });
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (msg === "userId-required" || msg === "itemId-required") {
          return res.status(400).json({ ok: false, error: msg });
        }
        if (msg === "item-not-found") {
          return res.status(404).json({ ok: false, error: msg });
        }
        if (msg === "item-disabled" || msg === "stock-shortage") {
          return res.status(400).json({ ok: false, error: msg });
        }
        throw err;
      }
    } catch (err: any) {
      if (err instanceof Error && err.message.endsWith("required")) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      if (err instanceof Error && err.message.endsWith("invalid")) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      log(`[ops] shop.purchase error: ${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

opsRouter.get("/:id/audit", async (req: Request, res: Response) => {
  try {
    const tenant = tenantId(req);
    const limit = clampLimit(req.query?.limit, 100);
    const dir = await ensureTenantDir(tenant);
    const events = await readLastN(auditPath(dir), limit);
    res.json({ items: events.slice(0, limit) });
  } catch (err: any) {
    log(`[ops] audit.get error: ${err?.message || err}`);
    res.status(500).json({ ok: false, error: "internal-error" });
  }
});

/* ===== New Ops API (tenant via query/body) ===== */
opsApiRouter.post(
  "/:tenant/manual-xp",
  mapTenantParam,
  requireEditorToken,
  jsonParser,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantFrom(req as AnyReq);
      const dir = await ensureTenantDir(tenant);
      const userId = normalizeUserId(req.body?.userId);
      if (!userId) {
        return res.status(400).json({ ok: false, error: "userId-required" });
      }
      const deltaXp = normalizeDelta(req.body?.deltaXp ?? req.body?.delta, -100000, 100000);
      if (deltaXp === null) {
        return res.status(400).json({ ok: false, error: "deltaXp-invalid" });
      }
      const reason = normalizeReason(req.body?.reason);
      const now = new Date().toISOString();
      const entry: ManualLogEntry = {
        id: randomUUID(),
        tenant,
        type: "xp",
        userId,
        deltaXp,
        reason,
        ip: req.ip,
        ua: req.get("user-agent") || undefined,
        createdAt: now,
      };
      await appendJsonl(manualPath(dir), entry);
      const audit: AuditEvent = {
        id: randomUUID(),
        tenant,
        actor: actorFrom(req),
        action: "manual.xp",
        detail: { userId, deltaXp, reason },
        ip: req.ip,
        ua: req.get("user-agent") || undefined,
        at: now,
      };
      await appendJsonl(auditPath(dir), audit);
      res.json({ ok: true, id: entry.id, createdAt: entry.createdAt });
    } catch (err: any) {
      log(`[ops] api.manual-xp error: ${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

opsApiRouter.post(
  "/:tenant/manual-level",
  mapTenantParam,
  requireEditorToken,
  jsonParser,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantFrom(req as AnyReq);
      const dir = await ensureTenantDir(tenant);
      const userId = normalizeUserId(req.body?.userId);
      if (!userId) {
        return res.status(400).json({ ok: false, error: "userId-required" });
      }
      const deltaLevel = normalizeDelta(
        req.body?.deltaLevel ?? req.body?.delta,
        -1000,
        1000
      );
      if (deltaLevel === null) {
        return res.status(400).json({ ok: false, error: "deltaLevel-invalid" });
      }
      const reason = normalizeReason(req.body?.reason);
      const now = new Date().toISOString();
      const entry: ManualLogEntry = {
        id: randomUUID(),
        tenant,
        type: "level",
        userId,
        deltaLevel,
        reason,
        ip: req.ip,
        ua: req.get("user-agent") || undefined,
        createdAt: now,
      };
      await appendJsonl(manualPath(dir), entry);
      const audit: AuditEvent = {
        id: randomUUID(),
        tenant,
        actor: actorFrom(req),
        action: "manual.level",
        detail: { userId, deltaLevel, reason },
        ip: req.ip,
        ua: req.get("user-agent") || undefined,
        at: now,
      };
      await appendJsonl(auditPath(dir), audit);
      res.json({ ok: true, id: entry.id, createdAt: entry.createdAt });
    } catch (err: any) {
      log(`[ops] api.manual-level error: ${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

opsApiRouter.post(
  "/:tenant/labels/bulk",
  mapTenantParam,
  requireEditorToken,
  jsonParser,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantFrom(req as AnyReq);
      const dir = await ensureTenantDir(tenant);
      const items = parseBulkLabelItems(req.body);
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ ok: false, error: "items-required" });
      }
      const saved = await writeLabels(tenant, { items });
      const audit: AuditEvent = {
        id: randomUUID(),
        tenant,
        actor: actorFrom(req),
        action: "labels.bulk.replace",
        detail: { count: saved.items?.length ?? 0 },
        ip: req.ip,
        ua: req.get("user-agent") || undefined,
        at: new Date().toISOString(),
      };
      await appendJsonl(auditPath(dir), audit);
      res.json({ ok: true, count: saved.items?.length ?? 0 });
    } catch (err: any) {
      log(`[ops] api.labels.bulk error: ${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

opsApiRouter.get(
  "/:tenant/audit",
  mapTenantParam,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantFrom(req as AnyReq);
      const limit = Math.min(200, clampLimit(req.query?.limit, 100));
      const dir = await ensureTenantDir(tenant);
      const events = await readLastN(auditPath(dir), limit);
      res.json({ items: events.slice(0, limit) });
    } catch (err: any) {
      log(`[ops] api.audit.get error: ${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

opsApiRouter.get("/catalog", async (req: Request, res: Response) => {
  try {
    const tenant = tenantFrom(req as AnyReq);
    const dir = await ensureTenantDir(tenant);
    const items = await readJson<LegacyShopItem[]>(shopPath(dir), []);
    res.json({ items: enrichItemsForResponse(normalizeShopItems(items)) });
  } catch (err: any) {
    log(`[ops] api.catalog.get error: ${err?.message || err}`);
    res.status(500).json({ ok: false, error: "internal-error" });
  }
});

opsApiRouter.put(
  "/catalog",
  jsonParser,
  ensureTenantFromBody,
  requireEditorToken,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantFrom(req as AnyReq);
      const dir = await ensureTenantDir(tenant);
      const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
      const items = normalizeShopItems(rawItems);
      await writeJson(shopPath(dir), items);

      const audit: AuditEvent = {
        id: randomUUID(),
        tenant,
        actor: actorFrom(req),
        action: "shop.item.put",
        detail: { count: items.length },
        ip: req.ip,
        at: new Date().toISOString(),
      };
      await appendJsonl(auditPath(dir), audit);
      res.json({ ok: true, count: items.length });
    } catch (err: any) {
      if (err instanceof Error && err.message.endsWith("required")) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      if (err instanceof Error && err.message.endsWith("invalid")) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      log(`[ops] api.catalog.put error: ${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

opsApiRouter.post(
  "/adjust",
  jsonParser,
  ensureTenantFromBody,
  requireEditorToken,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantFrom(req as AnyReq);
      let payload: ManualPayload;
      try {
        payload = extractManualPayload(req.body);
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (msg === "userId-required" || msg === "deltaXp-invalid") {
          return res.status(400).json({ ok: false, error: msg });
        }
        throw err;
      }
      const adjustment = await recordAdjustment(
        tenant,
        { ...payload, source: "manual" },
        req,
        {
          action: "adjust.create",
          detail: (adj) => ({
            id: adj.id,
            userId: adj.userId,
            deltaXp: adj.deltaXp,
            badge: adj.badge,
            note: adj.note,
          }),
        }
      );
      res.json({
        ok: true,
        id: adjustment.id,
        ts: adjustment.createdAt,
        deltaXp: adjustment.deltaXp,
      });
    } catch (err: any) {
      log(`[ops] api.adjust.post error: ${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

opsApiRouter.post(
  "/purchase",
  jsonParser,
  ensureTenantFromBody,
  requireEditorToken,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantFrom(req as AnyReq);
      try {
        const { adjustment, newStock } = await processPurchase(tenant, req.body, req);
        res.json({
          ok: true,
          newStock,
          adjustmentId: adjustment.id,
          deltaXp: adjustment.deltaXp,
        });
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (msg === "userId-required" || msg === "itemId-required") {
          return res.status(400).json({ ok: false, error: msg });
        }
        if (msg === "item-not-found") {
          return res.status(404).json({ ok: false, error: msg });
        }
        if (msg === "item-disabled" || msg === "stock-shortage") {
          return res.status(400).json({ ok: false, error: msg });
        }
        throw err;
      }
    } catch (err: any) {
      log(`[ops] api.purchase.post error: ${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

opsApiRouter.get("/logs", async (req: Request, res: Response) => {
  try {
    const tenant = tenantFrom(req as AnyReq);
    const limit = clampLimit(req.query?.limit, 100);
    const userIdFilter = req.query?.userId ? String(req.query.userId).trim() : null;
    const adjustments = await listAdjustments(tenant, limit, userIdFilter);
    const logs = adjustments
      .map((item) => toOpsLogEntry(tenant, item))
      .filter((entry): entry is OpsLogEntry => Boolean(entry))
      .slice(0, limit);
    res.json({ items: logs });
  } catch (err: any) {
    log(`[ops] api.logs.get error: ${err?.message || err}`);
    res.status(500).json({ ok: false, error: "internal-error" });
  }
});
