import path from "path";
import express, { type Request, type Response } from "express";
import { randomUUID } from "crypto";

import { requireEditorToken } from "../lib/auth.js";
import { log } from "../lib/utils.js";
import { SHOP_ALLOW_PAID, AUTO_PARTY_DOMAINS } from "../lib/env.js";
import { applyManualAdjustment } from "../features/manualAdjust.js";
import type { ManualAdjustRequest, Badge } from "../types/ops.js";
import {
  listShopItems,
  upsertShopItem,
  deleteShopItem,
  setShopItemActive,
  type ShopItemInput,
} from "../store/shopItems.js";
import { listBadges, upsertBadge, deleteBadge, type BadgeInput } from "../store/badges.js";
import { ensurePartyForDomain, joinParty } from "../connectors/habitica.js";
import { appendJsonl, ensureTenantDir } from "../store/ops.js";

export const tenantOpsRouter = express.Router({ mergeParams: true });
const jsonParser = express.json({ limit: "1mb" });

function tenantId(req: Request): string {
  const params = req.params as Record<string, any>;
  return String(params.id || params.tenant || "default");
}

function actorFrom(req: Request): string {
  const headers = ["x-actor", "x-operator", "x-editor", "x-editor-name", "x-user-name"];
  for (const key of headers) {
    const value = req.get(key);
    if (value && value.trim()) return value.trim();
  }
  return "api";
}

function sanitizeString(value: any, max = 256): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

function parseShopItem(body: any): ShopItemInput {
  const name = sanitizeString(body?.name ?? body?.title);
  if (!name) throw new Error("name-required");
  const valueNum = Number(body?.value ?? body?.price ?? body?.xp ?? body?.priceXp);
  if (!Number.isFinite(valueNum)) throw new Error("value-invalid");
  const value = Math.trunc(valueNum);
  if (value === 0) throw new Error("value-invalid");
  const description = sanitizeString(body?.description);
  const isPaid = body?.isPaid === true || String(body?.isPaid).toLowerCase() === "true";
  const active = body?.active === false ? false : true;
  const idRaw = sanitizeString(body?.id, 64);
  return {
    id: idRaw || undefined,
    name,
    description,
    value,
    isPaid,
    active,
  };
}

const BADGE_TYPES = new Set<Badge["criteria"]["type"]>([
  "totalXpAtLeast",
  "callsDurationMsAtLeast",
  "appointmentsCountAtLeast",
  "hasLabelCountAtLeast",
]);

function parseBadge(body: any): BadgeInput {
  const title = sanitizeString(body?.title);
  if (!title) throw new Error("title-required");
  const criteriaType = String(body?.criteria?.type || body?.type || "").trim() as Badge["criteria"]["type"];
  if (!BADGE_TYPES.has(criteriaType)) throw new Error("criteria-type-invalid");
  const thresholdRaw = Number(body?.criteria?.threshold ?? body?.threshold);
  if (!Number.isFinite(thresholdRaw)) throw new Error("threshold-invalid");
  const threshold = Math.max(0, Math.trunc(thresholdRaw));
  const labelId = sanitizeString(body?.criteria?.labelId ?? body?.labelId ?? body?.label);
  if (criteriaType === "hasLabelCountAtLeast" && !labelId) throw new Error("labelId-required");

  const description = sanitizeString(body?.description, 1024);
  const icon = sanitizeString(body?.icon, 128);
  const xp = body?.xp === undefined ? undefined : Number(body.xp);
  if (xp !== undefined && !Number.isFinite(xp)) throw new Error("xp-invalid");
  const active = body?.active === false ? false : true;
  const idRaw = sanitizeString(body?.id, 64);

  return {
    id: idRaw || undefined,
    title,
    description,
    xp: xp === undefined ? undefined : Number(xp),
    icon,
    criteria: {
      type: criteriaType,
      threshold,
      labelId,
    },
    active,
  };
}

tenantOpsRouter.post(
  "/adjust-xp",
  requireEditorToken,
  jsonParser,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantId(req);
      const payload = req.body as ManualAdjustRequest;
      const result = await applyManualAdjustment(tenant, payload);

      if (!result.cached) {
        const dir = await ensureTenantDir(tenant);
        const auditFile = path.join(dir, "audit.jsonl");
        const actor = actorFrom(req);
        const entries = [] as Array<{ action: string; detail: any }>;
        if (result.applied.deltaXp) {
          entries.push({
            action: "manual.xp",
            detail: {
              userId: result.userId,
              deltaXp: result.applied.deltaXp,
              reason: result.note,
              idempotencyKey: result.idempotencyKey,
            },
          });
        }
        if (result.applied.deltaLvl) {
          entries.push({
            action: "manual.level",
            detail: {
              userId: result.userId,
              deltaLevel: result.applied.deltaLvl,
              reason: result.note,
              idempotencyKey: result.idempotencyKey,
            },
          });
        }
        for (const entry of entries) {
          await appendJsonl(auditFile, {
            id: randomUUID(),
            tenant,
            actor,
            action: entry.action,
            detail: entry.detail,
            ip: req.ip,
            ua: req.get("user-agent") || undefined,
            at: result.createdAt,
          });
        }
      }

      res.json(result);
    } catch (err: any) {
      const msg = String(err?.code || err?.message || err);
      if (msg === "userId-required" || msg === "deltaXp-invalid" || msg === "deltaLvl-invalid") {
        return res.status(400).json({ ok: false, error: msg });
      }
      if (msg === "rate-limit") {
        return res.status(429).json({ ok: false, error: "rate-limit" });
      }
      log(`[tenantOps] adjust-xp error=${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

tenantOpsRouter.get("/items", async (req: Request, res: Response) => {
  try {
    const tenant = tenantId(req);
    const items = await listShopItems(tenant);
    const filtered = SHOP_ALLOW_PAID
      ? items
      : items.filter((item) => item.isPaid !== true);
    res.json({ items: filtered });
  } catch (err: any) {
    log(`[tenantOps] items.get error=${err?.message || err}`);
    res.status(500).json({ ok: false, error: "internal-error" });
  }
});

tenantOpsRouter.post(
  "/items",
  requireEditorToken,
  jsonParser,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantId(req);
      const input = parseShopItem(req.body || {});
      const saved = await upsertShopItem(tenant, input);
      res.json({ ok: true, item: saved });
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.endsWith("required") || msg.endsWith("invalid")) {
        return res.status(400).json({ ok: false, error: msg });
      }
      log(`[tenantOps] items.post error=${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

tenantOpsRouter.delete(
  "/items/:itemId",
  requireEditorToken,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantId(req);
      const itemId = String(req.params.itemId || "").trim();
      if (!itemId) return res.status(400).json({ ok: false, error: "id-required" });
      const hard = String(req.query?.hard || "").trim();
      const isHard = hard === "1" || hard.toLowerCase() === "true";
      if (isHard) await deleteShopItem(tenant, itemId, { hard: true });
      else await deleteShopItem(tenant, itemId);
      res.json({ ok: true });
    } catch (err: any) {
      log(`[tenantOps] items.delete error=${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

tenantOpsRouter.post(
  "/items/:itemId/restore",
  requireEditorToken,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantId(req);
      const itemId = String(req.params.itemId || "").trim();
      if (!itemId) return res.status(400).json({ ok: false, error: "id-required" });
      const restored = await setShopItemActive(tenant, itemId, true);
      if (!restored) return res.status(404).json({ ok: false, error: "not-found" });
      res.json({ ok: true, item: restored });
    } catch (err: any) {
      log(`[tenantOps] items.restore error=${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

tenantOpsRouter.get("/badges", async (req: Request, res: Response) => {
  try {
    const tenant = tenantId(req);
    const badges = await listBadges(tenant);
    res.json({ badges });
  } catch (err: any) {
    log(`[tenantOps] badges.get error=${err?.message || err}`);
    res.status(500).json({ ok: false, error: "internal-error" });
  }
});

tenantOpsRouter.post(
  "/badges",
  requireEditorToken,
  jsonParser,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantId(req);
      const badge = parseBadge(req.body || {});
      if (!badge.id) badge.id = randomUUID();
      const saved = await upsertBadge(tenant, badge);
      res.json({ ok: true, badge: saved });
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.endsWith("required") || msg.endsWith("invalid")) {
        return res.status(400).json({ ok: false, error: msg });
      }
      log(`[tenantOps] badges.post error=${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

tenantOpsRouter.put(
  "/badges",
  requireEditorToken,
  jsonParser,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantId(req);
      const arr = Array.isArray(req.body?.badges) ? req.body.badges : [];
      const results: Badge[] = [];
      for (const raw of arr) {
        const badge = parseBadge(raw);
        if (!badge.id) badge.id = randomUUID();
        results.push(await upsertBadge(tenant, badge));
      }
      res.json({ ok: true, badges: results });
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.endsWith("required") || msg.endsWith("invalid")) {
        return res.status(400).json({ ok: false, error: msg });
      }
      log(`[tenantOps] badges.put error=${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

tenantOpsRouter.delete(
  "/badges/:badgeId",
  requireEditorToken,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantId(req);
      const badgeId = String(req.params.badgeId || "").trim();
      if (!badgeId) return res.status(400).json({ ok: false, error: "id-required" });
      const hard = String(req.query?.hard || "").trim();
      const isHard = hard === "1" || hard.toLowerCase() === "true";
      if (isHard) await deleteBadge(tenant, badgeId, { hard: true });
      else await deleteBadge(tenant, badgeId);
      res.json({ ok: true });
    } catch (err: any) {
      log(`[tenantOps] badges.delete error=${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

function toEmailList(value: any): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry : entry?.email))
      .filter(Boolean)
      .map((email) => String(email).trim().toLowerCase())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

async function autoJoinParty(
  tenant: string,
  emails: string[]
): Promise<{ results: Array<{ domain: string; partyId: string; added: number }> }> {
  const allowed = (AUTO_PARTY_DOMAINS || []).map((d) => d.toLowerCase());
  if (!allowed.length) return { results: [] };
  const counters = new Map<string, { partyId: string; added: number }>();
  for (const email of emails) {
    const domain = email.split("@")[1];
    if (!domain || !allowed.includes(domain)) continue;
    const { partyId } = await ensurePartyForDomain(tenant, domain);
    await joinParty(email, partyId);
    const current = counters.get(domain) || { partyId, added: 0 };
    current.added += 1;
    counters.set(domain, current);
  }
  return {
    results: Array.from(counters.entries()).map(([domain, info]) => ({
      domain,
      partyId: info.partyId,
      added: info.added,
    })),
  };
}

tenantOpsRouter.post(
  "/users",
  requireEditorToken,
  jsonParser,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantId(req);
      const emails = toEmailList(req.body?.users ?? req.body?.emails ?? []);
      const { results } = await autoJoinParty(tenant, emails);
      res.json({ ok: true, results });
    } catch (err: any) {
      log(`[tenantOps] users.post error=${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);

tenantOpsRouter.post(
  "/party/bulk",
  requireEditorToken,
  jsonParser,
  async (req: Request, res: Response) => {
    try {
      const tenant = tenantId(req);
      const emails = toEmailList(req.body?.users ?? req.body?.emails ?? []);
      const { results } = await autoJoinParty(tenant, emails);
      const summary = results.reduce(
        (acc, entry) => {
          acc.addedCount += entry.added;
          acc.partyIds.push(entry.partyId);
          return acc;
        },
        { addedCount: 0, partyIds: [] as string[] }
      );
      res.json({ ok: true, addedCount: summary.addedCount, partyIds: summary.partyIds, results });
    } catch (err: any) {
      log(`[tenantOps] party.bulk error=${err?.message || err}`);
      res.status(500).json({ ok: false, error: "internal-error" });
    }
  }
);
