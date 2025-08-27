import express, { Request, Response } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { RateLimiterMemory } from "rate-limiter-flexible";

const router = express.Router();

// ====== Settings ======
const DATA_DIR = path.resolve("data");
const EVENTS_DIR = path.join(DATA_DIR, "events");
const HUBSPOT_SECRET = process.env.HUBSPOT_WEBHOOK_SIGNING_SECRET || "";
const ZOOM_SECRET = process.env.ZOOM_WEBHOOK_SECRET_TOKEN || "";
const MOCK_MODE = (process.env.MOCK_MODE || "false").toLowerCase() === "true";

// 60 req/min
const limiter = new RateLimiterMemory({ points: 60, duration: 60 });

// Dedup (in-memory)
const SEEN_MAX = 2000;
const seen = new Map<string, number>();
function dedupeKeyFor(provider: string, rawBody: Buffer, headerSig: string, extra?: string) {
  const h = crypto.createHash("sha256");
  h.update(provider);
  h.update(headerSig || "");
  if (extra) h.update(extra);
  h.update(rawBody);
  return h.digest("hex");
}
function markSeen(key: string): boolean {
  if (seen.has(key)) return true;
  seen.set(key, Date.now());
  if (seen.size > SEEN_MAX) {
    const oldest = [...seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, Math.max(0, seen.size - SEEN_MAX));
    for (const [k] of oldest) seen.delete(k);
  }
  return false;
}
function safeEq(a: string, b: string) {
  const ab = Buffer.from(a || "", "utf8");
  const bb = Buffer.from(b || "", "utf8");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(EVENTS_DIR)) fs.mkdirSync(EVENTS_DIR, { recursive: true });
}
function appendJsonl(file: string, obj: any) {
  fs.appendFileSync(file, JSON.stringify(obj) + "\n", { encoding: "utf8" });
}

// Raw body（server.ts 側で req.rawBody を設定している前提。無ければフォールバック）
function getRawBody(req: any): Buffer {
  if (req.rawBody && Buffer.isBuffer(req.rawBody)) return req.rawBody as Buffer;
  return Buffer.from(JSON.stringify(req.body || {}), "utf8");
}

// ====== Signature Verifiers ======
// HubSpot v3: base = `${method}${fullUrl}${body}` → HMAC-SHA256(secret) → base64
function verifyHubSpotV3(req: Request, raw: Buffer) {
  const sigHeader = req.get("X-HubSpot-Signature-v3") || "";
  if (!HUBSPOT_SECRET) return false;
  const method = (req.method || "POST").toUpperCase();
  const host = req.get("x-forwarded-host") || req.get("host");
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  const fullUrl = `${proto}://${host}${req.originalUrl}`;
  const base = `${method}${fullUrl}${raw.toString("utf8")}`;
  const mac = crypto.createHmac("sha256", HUBSPOT_SECRET).update(base).digest("base64");
  return safeEq(mac, sigHeader);
}

// Zoom: 代表的な2方式を試行
function verifyZoom(req: Request, raw: Buffer) {
  const sigHeader = req.get("x-zm-signature") || "";
  const ts = req.get("x-zm-request-timestamp") || "";
  if (!ZOOM_SECRET || !sigHeader) return false;
  const rawStr = raw.toString("utf8");
  const try1 = crypto.createHmac("sha256", ZOOM_SECRET).update(`${ts}${rawStr}`).digest("base64");
  if (safeEq(sigHeader, try1)) return true;
  const try2 = crypto.createHmac("sha256", ZOOM_SECRET).update(`v0:${ts}:${rawStr}`).digest("base64");
  if (safeEq(sigHeader, try2)) return true;
  return false;
}

async function guardRate(_req: Request, res: Response) {
  try {
    await limiter.consume("webhooks");
    return true;
  } catch {
    res.status(429).json({ ok: false, error: "rate_limited" });
    return false;
  }
}

// ====== Routes ======
router.post("/hubspot", async (req: Request, res: Response) => {
  if (!(await guardRate(req, res))) return;

  const raw = getRawBody(req);
  const ok = MOCK_MODE ? true : verifyHubSpotV3(req, raw);
  if (!ok) return res.status(401).json({ ok: false, error: "invalid_signature" });

  ensureDirs();
  const now = new Date().toISOString();
  const events = Array.isArray(req.body) ? req.body : [req.body];

  let wrote = 0;
  for (const ev of events) {
    const evId: string =
      ev?.eventId || ev?.id || crypto.createHash("sha256").update(JSON.stringify(ev)).digest("hex");
    const key = dedupeKeyFor("hubspot", raw, req.get("X-HubSpot-Signature-v3") || "", evId);
    if (markSeen(key)) continue;

    const out = {
      provider: "hubspot",
      receivedAt: now,
      eventId: evId,
      payload: ev,
      headers: { "x-hubspot-signature-v3": req.get("X-HubSpot-Signature-v3") },
    };
    appendJsonl(path.join(EVENTS_DIR, "hubspot.jsonl"), out);
    wrote++;
  }
  res.json({ ok: true, wrote });
});

router.post("/zoom", async (req: Request, res: Response) => {
  if (!(await guardRate(req, res))) return;

  const raw = getRawBody(req);
  const ok = MOCK_MODE ? true : verifyZoom(req, raw);
  if (!ok) return res.status(401).json({ ok: false, error: "invalid_signature" });

  ensureDirs();
  const now = new Date().toISOString();
  const ev = req.body || {};
  const evId: string =
    ev?.payload?.object?.uuid ||
    ev?.event_ts?.toString?.() ||
    crypto.createHash("sha256").update(JSON.stringify(ev)).digest("hex");

  const key = dedupeKeyFor("zoom", raw, req.get("x-zm-signature") || "", evId);
  if (!markSeen(key)) {
    const out = {
      provider: "zoom",
      receivedAt: now,
      eventId: evId,
      payload: ev,
      headers: {
        "x-zm-signature": req.get("x-zm-signature"),
        "x-zm-request-timestamp": req.get("x-zm-request-timestamp"),
      },
    };
    appendJsonl(path.join(EVENTS_DIR, "zoom.jsonl"), out);
    return res.json({ ok: true, wrote: 1 });
  }
  res.json({ ok: true, wrote: 0, deduped: true });
});

router.get("/healthz", (_req, res) => res.json({ ok: true }));

export default router;
