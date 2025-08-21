import { Request, Response } from "express";
import crypto from "crypto";
import yaml from "js-yaml";
import fs from "fs";
import path from "path";

import { buildUserLookup } from "../utils/users";
import { isProcessed, markProcessed } from "../utils/idempotency";
import { sendChatworkMessage } from "../connectors/chatwork";
import {
  addXpForKpi,
  addNewAppointment,
  addApproval,
  addSales,
  HabiticaCred,
} from "../connectors/habitica";

// 環境変数から署名検証に使う秘密鍵を読み込む
const HUBSPOT_SECRET = process.env.HUBSPOT_WEBHOOK_SIGNING_SECRET || "";
const ZOOM_SECRET = process.env.ZOOM_WEBHOOK_SECRET_TOKEN || "";

// goals.yml を読み込み、得点を参照する
const goals = yaml.load(fs.readFileSync(path.resolve(process.cwd(), "config/goals.yml"), "utf-8")) as any;

/** HubSpot署名検証 */
function validateHubspot(req: Request): boolean {
  const signature = req.headers["x-hubspot-signature"] as string;
  if (!signature || !HUBSPOT_SECRET) return false;
  const payload = JSON.stringify(req.body);
  const digest = crypto.createHmac("sha256", HUBSPOT_SECRET).update(payload).digest("hex");
  return digest === signature;
}

/** Zoom署名検証 */
function validateZoom(req: Request): boolean {
  const token = req.headers["x-zm-signature"] as string;
  return !!ZOOM_SECRET && token === ZOOM_SECRET;
}

/** HubSpot Webhook ハンドラ */
export async function handleHubspotWebhook(req: Request, res: Response) {
  if (HUBSPOT_SECRET && !validateHubspot(req)) {
    return res.status(401).send("Invalid signature");
  }
  const event = req.body;
  const objectId = String(event.objectId);
  if (isProcessed(objectId)) {
    return res.status(200).send("Duplicate");
  }
  markProcessed(objectId);

  const { byHubSpot } = buildUserLookup();

  // 新規アポ検出
  if (event.subscriptionType === "engagement.created" && event.objectType === "CALL") {
    const props = event.properties || {};
    const disposition = props.hs_call_disposition;
    const ownerId = String(props.hs_owner_id);
    const user = byHubSpot[ownerId];
    if (!user) {
      console.warn("Unknown HubSpot owner:", ownerId);
      return res.status(200).send("Unknown owner");
    }
    // 新規アポ判定値を環境変数またはデフォルトから取得
    const list = (process.env.HUBSPOT_NEW_APPOINT_VALUES || "新規アポ,Appointment Booked").split(",");
    if (list.includes(disposition)) {
      const cred: HabiticaCred = { userId: user.habitica_user_id, apiToken: user.habitica_api_token };
      await addNewAppointment(cred, 1);
      const xp = goals.points?.new_appoint?.pt_per_unit ?? 20;
      const msg = `🎉 ${user.display_name} が新規アポを獲得！ (+${xp}XP)`;
      await sendChatworkMessage(msg);
    }
  }
  res.status(200).send("OK");
}

/** Zoom Phone Webhook ハンドラ */
export async function handleZoomWebhook(req: Request, res: Response) {
  if (ZOOM_SECRET && !validateZoom(req)) {
    return res.status(401).send("Invalid signature");
  }
  const { event, payload } = req.body || {};
  if (event !== "call.ended") return res.status(200).send("Ignored");

  const call = payload?.object || {};
  const callId = String(call.call_id);
  if (isProcessed(callId)) {
    return res.status(200).send("Duplicate");
  }
  markProcessed(callId);

  const userId = call.user_id;
  const direction = call.direction;
  const durationSec = Number(call.duration || 0);
  if (direction !== "outbound") {
    return res.status(200).send("OK");
  }
  const { byZoom } = buildUserLookup();
  const user = byZoom[userId];
  if (!user) {
    console.warn("Unknown Zoom user:", userId);
    return res.status(200).send("Unknown user");
  }
  const calls = 1;
  const minutes = Math.floor(durationSec / 60);
  const cred: HabiticaCred = { userId: user.habitica_user_id, apiToken: user.habitica_api_token };
  await addXpForKpi(cred, calls, minutes, 5);
  res.status(200).send("OK");
}
