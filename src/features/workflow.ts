import { Request, Response } from "express";
import { AUTH_TOKEN } from "../lib/env.js";
import { handleNormalizedEvent } from "./appointment.js";
import { inferDurationMs } from "./callsXP.js";

function requireBearer(req: Request, res: Response): boolean {
  const token = (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!AUTH_TOKEN) { res.status(500).json({ ok: false, error: "missing AUTH_TOKEN" }); return false; }
  if (token !== AUTH_TOKEN) { res.status(401).json({ ok: false, error: "auth" }); return false; }
  return true;
}

export async function workflowWebhook(req: Request, res: Response) {
  if (!requireBearer(req, res)) return;

  const b: any = (req as any).body || {};
  const outcome = b.outcome || b.hs_call_disposition || b.properties?.hs_call_disposition;
  const callId = b.callId || b.engagementId || b.id;
  const occurredAt = b.endedAt || b.occurredAt || b.timestamp || b.properties?.hs_timestamp;

  await handleNormalizedEvent({ source: "workflow", eventId: b.eventId || callId, callId, outcome, occurredAt, raw: b });

  if (b.type === "call.duration") {
    const ms = inferDurationMs(b.durationMs ?? b.durationSec);
    // Workflowからの duration はZoom側と二重計上しないため無視
  }
  res.json({ ok: true });
}
