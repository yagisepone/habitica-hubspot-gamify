import express, { type Request, type Response } from "express";
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
import type { AuditEvent, ShopItem, XpAdjustment } from "../types/ops.js";

export const opsRouter = express.Router();
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

function normalizeShopItems(items: any[]): ShopItem[] {
  if (!Array.isArray(items)) return [];
  const norm: ShopItem[] = [];
  for (const raw of items) {
    const title = String(raw?.title ?? "").trim();
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
    const item: ShopItem = {
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

function enrichItemsForResponse(items: ShopItem[]): ShopItem[] {
  return items.map((item) => ({
    ...item,
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

function tenantId(req: Request): string {
  return tenantFrom(req as AnyReq);
}

opsRouter.get("/:id/adjustments", async (req: Request, res: Response) => {
  try {
    const tenant = tenantId(req);
    const limit = clampLimit(req.query?.limit, 100);
    const userIdFilter = req.query?.userId ? String(req.query.userId) : null;
    const dir = await ensureTenantDir(tenant);
    const items = await readLastN(adjustmentsPath(dir), limit);
    const filtered = userIdFilter
      ? items.filter((item) => String(item?.userId || "") === userIdFilter)
      : items;
    res.json({ items: filtered.slice(0, limit) });
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
      const dir = await ensureTenantDir(tenant);
      const { userId, userName, deltaXp, badge, note } = req.body || {};
      if (!userId || !String(userId).trim()) {
        return res.status(400).json({ ok: false, error: "userId-required" });
      }
      const delta = Number(deltaXp);
      if (!Number.isFinite(delta)) {
        return res.status(400).json({ ok: false, error: "deltaXp-invalid" });
      }
      const adjustment: XpAdjustment = {
        id: randomUUID(),
        tenant,
        userId: String(userId).trim(),
        userName: userName ? String(userName).trim() || undefined : undefined,
        deltaXp: Math.trunc(delta),
        badge: badge ? String(badge).trim() || undefined : undefined,
        note: note ? String(note).trim() || undefined : undefined,
        source: "manual",
        createdAt: new Date().toISOString(),
      };
      await appendJsonl(adjustmentsPath(dir), adjustment);

      const audit: AuditEvent = {
        id: randomUUID(),
        tenant,
        actor: actorFrom(req),
        action: "adjust.create",
        detail: {
          id: adjustment.id,
          userId: adjustment.userId,
          deltaXp: adjustment.deltaXp,
          badge: adjustment.badge,
          note: adjustment.note,
        },
        ip: req.ip,
        at: new Date().toISOString(),
      };
      await appendJsonl(auditPath(dir), audit);
      res.json({ ok: true, id: adjustment.id });
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
    const items = await readJson<ShopItem[]>(shopPath(dir), []);
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
      const dir = await ensureTenantDir(tenant);
      const { userId, userName, itemId, qty } = req.body || {};
      if (!userId || !String(userId).trim()) {
        return res.status(400).json({ ok: false, error: "userId-required" });
      }
      if (!itemId || !String(itemId).trim()) {
        return res.status(400).json({ ok: false, error: "itemId-required" });
      }
      const quantity = Number.isFinite(Number(qty)) ? Math.max(1, Math.floor(Number(qty))) : 1;

      const shopFile = shopPath(dir);
      const currentItems = normalizeShopItems(await readJson<ShopItem[]>(shopFile, []));
      const item = currentItems.find((it) => it.id === String(itemId));
      if (!item) {
        return res.status(404).json({ ok: false, error: "item-not-found" });
      }
      if (item.enabled === false) {
        return res.status(400).json({ ok: false, error: "item-disabled" });
      }
      if (item.stock != null) {
        if (item.stock < quantity) {
          return res.status(400).json({ ok: false, error: "stock-shortage" });
        }
        item.stock -= quantity;
        if (item.stock < 0) item.stock = 0;
      }

      const deltaXp = -Math.abs(item.priceXp) * quantity;
      const adjustment: XpAdjustment = {
        id: randomUUID(),
        tenant,
        userId: String(userId).trim(),
        userName: userName ? String(userName).trim() || undefined : undefined,
        deltaXp,
        badge: item.badgeOnBuy ? String(item.badgeOnBuy) : undefined,
        note: `shop:${item.title} x${quantity}`,
        source: "shop",
        createdAt: new Date().toISOString(),
      };

      await writeJson(shopFile, currentItems);
      await appendJsonl(adjustmentsPath(dir), adjustment);

      const audit: AuditEvent = {
        id: randomUUID(),
        tenant,
        actor: actorFrom(req),
        action: "shop.purchase",
        detail: {
          itemId: item.id,
          title: item.title,
          qty: quantity,
          userId: adjustment.userId,
          deltaXp: adjustment.deltaXp,
          newStock: item.stock ?? null,
        },
        ip: req.ip,
        at: new Date().toISOString(),
      };
      await appendJsonl(auditPath(dir), audit);

      res.json({
        ok: true,
        newStock: item.stock ?? null,
        adjustmentId: adjustment.id,
      });
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
