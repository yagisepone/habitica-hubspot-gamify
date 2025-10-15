import path from "path";
import { randomUUID } from "crypto";
import { adjustUserStats } from "../connectors/habitica.js";
import { log } from "../lib/utils.js";
import { appendJsonl, ensureTenantDir } from "../store/ops.js";
import type { ManualAdjustRequest, XpAdjustment } from "../types/ops.js";
import { checkAndAwardBadges } from "./badges.js";

const RATE_CAP = 5;
const RATE_REFILL_MS = 10_000;
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

type RateBucket = { tokens: number; updatedAt: number };
type IdempotentEntry = { expiresAt: number; response: ManualAdjustResult };

const rateBuckets = new Map<string, RateBucket>();
const idempotencyCache = new Map<string, IdempotentEntry>();

export interface ManualAdjustResult {
  ok: true;
  applied: { deltaXp: number; deltaLvl?: number };
  userId: string;
  note?: string;
  idempotencyKey?: string;
  adjustmentId: string;
  createdAt: string;
  cached: boolean;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function ensureRateAllowance(key: string) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) ?? { tokens: RATE_CAP, updatedAt: now };
  const elapsed = now - bucket.updatedAt;
  if (elapsed > 0) {
    const refill = Math.floor(elapsed / RATE_REFILL_MS);
    if (refill > 0) {
      bucket.tokens = Math.min(RATE_CAP, bucket.tokens + refill);
      bucket.updatedAt = now;
    }
  }
  if (bucket.tokens <= 0) {
    throw Object.assign(new Error("rate-limit"), { code: "rate-limit" });
  }
  bucket.tokens -= 1;
  bucket.updatedAt = now;
  rateBuckets.set(key, bucket);
}

function makeIdempotencyKey(tenantId: string, request: ManualAdjustRequest): string | null {
  if (!request.idempotencyKey) return null;
  return `${tenantId}::${request.userId}::${request.idempotencyKey}`;
}

function trimCache() {
  const now = Date.now();
  for (const [key, entry] of idempotencyCache.entries()) {
    if (entry.expiresAt <= now) idempotencyCache.delete(key);
  }
}

function validateRequest(body: ManualAdjustRequest): ManualAdjustRequest {
  const userId = String(body?.userId ?? "").trim();
  if (!userId) {
    throw Object.assign(new Error("userId-required"), { code: "userId-required" });
  }
  const deltaXpNum = Number(body?.deltaXp);
  if (!Number.isFinite(deltaXpNum)) {
    throw Object.assign(new Error("deltaXp-invalid"), { code: "deltaXp-invalid" });
  }
  const deltaXp = clampInt(deltaXpNum, -100000, 100000);
  const deltaLvlRaw = (body as any)?.deltaLvl ?? (body as any)?.deltaLevel;
  let deltaLvl: number | undefined;
  if (deltaLvlRaw !== undefined && deltaLvlRaw !== null && String(deltaLvlRaw).trim() !== "") {
    const lvlNum = Number(deltaLvlRaw);
    if (!Number.isFinite(lvlNum)) {
      throw Object.assign(new Error("deltaLvl-invalid"), { code: "deltaLvl-invalid" });
    }
    deltaLvl = clampInt(lvlNum, -50, 50);
  }
  const note = body?.note ? String(body.note).trim().slice(0, 512) : undefined;
  const idempotencyKey = body?.idempotencyKey ? String(body.idempotencyKey).trim().slice(0, 128) : undefined;
  return { userId, deltaXp, deltaLvl, note, idempotencyKey };
}

function adjustmentsPath(dir: string) {
  return path.join(dir, "adjustments.jsonl");
}

export async function applyManualAdjustment(
  tenantId: string,
  rawBody: ManualAdjustRequest
): Promise<ManualAdjustResult> {
  trimCache();
  const request = validateRequest(rawBody);

  const key = makeIdempotencyKey(tenantId, request);
  if (key) {
    const cached = idempotencyCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.response, cached: true };
    }
  }

  const rateKey = `${tenantId}:${request.userId}`;
  ensureRateAllowance(rateKey);

  const dir = await ensureTenantDir(tenantId);
  const adjustmentId = randomUUID();
  const nowIso = new Date().toISOString();

  if (request.deltaXp !== 0 || (request.deltaLvl || 0) !== 0) {
    await adjustUserStats(tenantId, request.userId, request.deltaXp, request.deltaLvl);
  }

  const adjustment: XpAdjustment = {
    id: adjustmentId,
    tenant: tenantId,
    userId: request.userId,
    deltaXp: request.deltaXp,
    deltaLevel: request.deltaLvl,
    note: request.note,
    source: "manual",
    idempotencyKey: request.idempotencyKey,
    createdAt: nowIso,
  };

  await appendJsonl(adjustmentsPath(dir), adjustment);
  log(`[manual-adjust] tenant=${tenantId} user=${request.userId} xp=${request.deltaXp} lvl=${request.deltaLvl ?? 0}`);

  try {
    await checkAndAwardBadges(tenantId, request.userId, {
      type: "manualAdjust",
      metrics: {
        deltaXp: request.deltaXp,
        deltaLvl: request.deltaLvl ?? 0,
      },
    });
  } catch (err: any) {
    log(`[manual-adjust] badge-check error=${err?.message || err}`);
  }

  const response: ManualAdjustResult = {
    ok: true,
    applied: { deltaXp: request.deltaXp, deltaLvl: request.deltaLvl },
    userId: request.userId,
    note: request.note,
    idempotencyKey: request.idempotencyKey,
    adjustmentId,
    createdAt: nowIso,
    cached: false,
  };

  if (key) {
    const stored = { ...response, cached: false };
    idempotencyCache.set(key, { expiresAt: Date.now() + IDEMPOTENCY_TTL_MS, response: stored });
  }

  return response;
}
