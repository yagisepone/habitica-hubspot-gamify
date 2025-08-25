import { Request, Response } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import dayjs from "dayjs";

import { buildUserLookup } from "../utils/users";
import { isProcessed, markProcessed } from "../utils/idempotency";
import { sendChatworkMessage } from "../connectors/chatwork";
import {
  addXpForKpi,
  addNewAppointment,
  HabiticaCred,
} from "../connectors/habitica";

const HUBSPOT_SECRET = process.env.HUBSPOT_WEBHOOK_SIGNING_SECRET || "";
const ZOOM_SECRET = process.env.ZOOM_WEBHOOK_SECRET_TOKEN || "";

const goals = yaml.load(
  fs.readFileSync(path.resolve(process.cwd(), "config/goals.yml"), "utf-8")
) as any;

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function appendJsonl(filePath: string, obj: any) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf-8");
}

function validateHubspot(req: Request): boolean {
  if (!HUBSPOT_SECRET) return true;
  const payload = (req as any).rawBody ?? JSON.stringify(req.body);
  const digest = crypto.createHmac("sha256", HUBSPOT_SECRET).update(payload).digest("hex");
  const signature = String(req.headers["x-hubspot-signature"] || "");
  return digest === signature;
}

function validateZoom(req: Request): boolean {
  if (!ZOOM_SECRET) return true;
  const token = String(req.headers["x-zm-signature"] || "");
  return token === ZOOM_SECRET;
}

/** HubSpot Webhook（新規アポ判定） */
export async function handleHubspotWebhook(req: Request, res: Response) {
  if (!validateHubspot(req)) return res.status(401).send("Invalid signature");

  const event = req.body || {};
  const objectId = String(event.objectId ?? event.eventId ?? "");
  if (!objectId) return res.status(400).send("No objectId");

  if (isProcessed(objectId)) return res.status(200).send("Duplicate");
  markProcessed(objectId);

  const { byHubSpot } = buildUserLookup();

  if (event.subscriptionType === "engagement.created" && event.objectType === "CALL") {
    const props = event.properties || {};
    const disposition = String(props.hs_call_disposition ?? "");
    const ownerId = String(props.hs_owner_id ?? "");
    const ts = props.hs_timestamp || event.occurredAt || Date.now();

    const user = byHubSpot[ownerId];
    if (!user) {
      console.warn("[HubSpot] unknown owner:", ownerId);
      return res.status(200).send("Unknown owner");
    }

    const values = (process.env.HUBSPOT_NEW_APPOINT_VALUES || "新規アポ,Appointment Booked")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    if (values.includes(disposition)) {
      const cred: HabiticaCred = { userId: user.habitica_user_id, apiToken: user.habitica_api_token };
      await addNewAppointment(cred, 1);

      // Chatwork通知
      const xp = goals?.points?.new_appoint?.pt_per_unit ?? 20;
      await sendChatworkMessage(`🎉 ${user.display_name} が新規アポを獲得！ (+${xp}XP)`);

      // イベントログ
      appendJsonl(
        path.resolve(process.cwd(), "data/events/hubspot_appointments.jsonl"),
        {
          type: "new_appointment",
          owner_id: ownerId,
          canonical_user_id: user.canonical_user_id,
          display_name: user.display_name,
          disposition,
          occurred_at: dayjs(Number(ts)).toISOString(),
          object_id: objectId,
        }
      );
    }
  }

  return res.status(200).send("OK");
}

/** Zoom Phone Webhook（架電/通話時間） */
export async function handleZoomWebhook(req: Request, res: Response) {
  if (!validateZoom(req)) return res.status(401).send("Invalid signature");

  const { event, payload } = req.body || {};
  if (event !== "call.ended") return res.status(200).send("Ignored");

  const call = payload?.object || {};
  const callId = String(call.call_id || "");
  if (!callId) return res.status(400).send("No call_id");

  if (isProcessed(callId)) return res.status(200).send("Duplicate");
  markProcessed(callId);

  const { byZoom } = buildUserLookup();
  const user = byZoom[String(call.user_id || "")];
  if (!user) {
    console.warn("[Zoom] unknown user_id:", call.user_id);
    return res.status(200).send("Unknown user");
  }

  if (String(call.direction) !== "outbound") {
    return res.status(200).send("OK"); // 受電は対象外
  }

  const durationSec = Number(call.duration || 0);
  const minutes = Math.floor(durationSec / 60);
  const calls = 1;

  const cred: HabiticaCred = { userId: user.habitica_user_id, apiToken: user.habitica_api_token };
  await addXpForKpi(cred, calls, minutes, 5);

  // イベントログ
  appendJsonl(
    path.resolve(process.cwd(), "data/events/zoom_calls.jsonl"),
    {
      type: "outbound_call",
      zoom_user_id: call.user_id,
      canonical_user_id: user.canonical_user_id,
      display_name: user.display_name,
      call_id: callId,
      duration_sec: durationSec,
      end_time: call.end_time || null
    }
  );

  return res.status(200).send("OK");
}
