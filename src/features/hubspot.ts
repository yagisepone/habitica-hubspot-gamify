// src/features/hubspot.ts
import { Request, Response } from "express";
import crypto from "crypto";
import { PUBLIC_BASE_URL, WEBHOOK_SECRET } from "../lib/env.js";
import { timingEqual } from "../lib/utils.js";
import { handleNormalizedEvent } from "./appointment.js";
import { inferDurationMs, handleCallDurationEvent } from "./callsXP.js";
import { hasSeen, markSeen } from "../lib/seen.js";

/* HubSpot v3 Webhook（署名検証） */
export async function hubspotWebhook(req: Request & { rawBody?: Buffer }, res: Response) {
  const method = (req.method || "POST").toUpperCase();
  const withQuery = (req as any).originalUrl || (req as any).url || "/webhooks/hubspot";
  const urlObj = new URL(withQuery, "http://dummy.local");
  const pathOnly = urlObj.pathname + (urlObj.search || "");
  const tsHeader = req.header("x-hubspot-request-timestamp") || "";
  const sigHeader = req.header("x-hubspot-signature-v3") || "";
  const raw: Buffer =
    (req as any).rawBody ?? Buffer.from(JSON.stringify((req as any).body || ""), "utf8");

  const proto =
    String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
    (req as any).protocol ||
    "https";
  const hostHdr = String(req.headers["x-forwarded-host"] || req.headers["host"] || "")
    .split(",")[0]
    .trim();
  const candidates = new Set<string>();
  const add = (u: string) => {
    if (!u) return;
    candidates.add(u);
    candidates.add(u.endsWith("/") ? u.slice(0, -1) : u + "/");
  };
  add(withQuery);
  add(pathOnly);
  if (hostHdr) {
    add(`${proto}://${hostHdr}${withQuery}`);
    add(`${proto}://${hostHdr}${pathOnly}`);
  }
  if (PUBLIC_BASE_URL) {
    add(new URL(withQuery, PUBLIC_BASE_URL).toString());
    add(new URL(pathOnly, PUBLIC_BASE_URL).toString());
  }

  const calc = Array.from(candidates).map((u) => {
    const base = Buffer.concat([
      Buffer.from(method),
      Buffer.from(u),
      raw,
      Buffer.from(tsHeader),
    ]);
    const h = crypto.createHmac("sha256", WEBHOOK_SECRET).update(base).digest("base64");
    return { u, h };
  });
  const ok = calc.some((c) => timingEqual(c.h, sigHeader));

  // 204を先に返してOK
  res.status(204).end();

  // 本体解析
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {}
  if (!ok || !Array.isArray(parsed)) return;

  for (const e of parsed) {
    const isCall =
      String(e.subscriptionType || "").toLowerCase().includes("call") ||
      String(e.objectTypeId || "") === "0-48";

    if (isCall && e.propertyName === "hs_call_disposition") {
      await handleNormalizedEvent({
        source: "v3",
        eventId: e.eventId ?? e.attemptNumber,
        callId: e.objectId,
        outcome: e.propertyValue,
        occurredAt: e.occurredAt,
        raw: e,
      });
    }

    if (isCall && e.propertyName === "hs_call_duration") {
      const ms = inferDurationMs(e.propertyValue);
      if (!hasSeen(e.eventId ?? e.attemptNumber ?? e.objectId)) {
        markSeen(e.eventId ?? e.attemptNumber ?? e.objectId);
        await handleCallDurationEvent({
          source: "v3",
          eventId: e.eventId ?? e.attemptNumber,
          callId: e.objectId,
          durationMs: ms,
          occurredAt: e.occurredAt,
          raw: e,
        });
      }
    }
  }
}
