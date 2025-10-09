// src/features/zoom.ts
import { Request, Response } from "express";
import crypto from "crypto";
import {
  AUTH_TOKEN,
  ZOOM_BEARER_TOKEN,
  ZOOM_SIG_SKEW,
  ZOOM_VERIFICATION_TOKEN,
  ZOOM_WEBHOOK_SECRET,
} from "../lib/env.js";
import { appendJsonl, fmtJST, isoDay, log } from "../lib/utils.js";
import { ZOOM_UID2MAIL } from "../lib/maps.js";
import { awardXpForCallDuration, inferDurationMs } from "./callsXP.js";

function readBearerFromHeaders(req: Request) {
  for (const k of [
    "authorization",
    "x-authorization",
    "x-auth",
    "x-zoom-authorization",
    "zoom-authorization",
  ]) {
    const v = req.get(k);
    if (!v) continue;
    const m = v.trim().match(/^Bearer\s+(.+)$/i);
    return (m ? m[1] : v).trim();
  }
  return "";
}

function verifyZoomSignature(req: Request & { rawBody?: Buffer }) {
  const header = req.get("x-zm-signature") || "";
  if (!header) return { ok: false, why: "no_header" };
  const body = (req.rawBody ?? Buffer.from("", "utf8")).toString("utf8");

  const mHex = header.match(/^v0=([a-f0-9]{64})$/i);
  if (mHex) {
    const sigHex = mHex[1].toLowerCase();
    const eq = (hex: string) => {
      try {
        return crypto.timingSafeEqual(Buffer.from(sigHex, "hex"), Buffer.from(hex, "hex"));
      } catch {
        return false;
      }
    };
    if (ZOOM_VERIFICATION_TOKEN) {
      const vt = crypto.createHmac("sha256", ZOOM_VERIFICATION_TOKEN).update(body).digest("hex");
      if (eq(vt)) return { ok: true, variant: "hex_vtoken" };
    }
    if (ZOOM_WEBHOOK_SECRET) {
      const h1 = crypto.createHmac("sha256", ZOOM_WEBHOOK_SECRET).update(body).digest("hex");
      const h2 = crypto.createHmac("sha256", ZOOM_WEBHOOK_SECRET).update("v0" + body).digest("hex");
      const h3 = crypto.createHmac("sha256", ZOOM_WEBHOOK_SECRET).update("v0:" + body).digest("hex");
      if (eq(h1) || eq(h2) || eq(h3)) return { ok: true, variant: "hex_secret" };
    }
    return { ok: false, why: "signature_mismatch_hex" };
  }

  const m = header.match(/^v0[:=](\d+):([A-Za-z0-9+/=]+)$/);
  if (!m) return { ok: false, why: "bad_format" };
  const ts = Number(m[1]);
  const sig = m[2];
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > ZOOM_SIG_SKEW) return { ok: false, why: "timestamp_skew" };
  if (!ZOOM_WEBHOOK_SECRET) return { ok: false, why: "no_secret" };

  const macA = crypto.createHmac("sha256", ZOOM_WEBHOOK_SECRET).update(`${ts}${body}`).digest("base64");
  const macB = crypto.createHmac("sha256", ZOOM_WEBHOOK_SECRET).update(`v0:${ts}:${body}`).digest("base64");
  const eqB64 = (mac: string) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sig));
    } catch {
      return false;
    }
  };
  return { ok: eqB64(macA) || eqB64(macB), variant: "v0_ts_b64" };
}

function pickZoomInfo(obj: any) {
  const o = obj || {};
  const logs: any[] = Array.isArray(o.call_logs)
    ? o.call_logs
    : Array.isArray(o?.object?.call_logs)
    ? o.object.call_logs
    : [];
  const chosen =
    logs.find((x) => String(x?.direction || "").toLowerCase() === "outbound") || logs[0] || o;

  const emailRaw =
    o.user_email ||
    o.owner_email ||
    o.caller_email ||
    o.callee_email ||
    chosen?.caller_email ||
    chosen?.callee_email ||
    "";
  const email = String(emailRaw || "").toLowerCase() || undefined;

  const zid =
    o.zoom_user_id ||
    o.user_id ||
    o.owner_id ||
    chosen?.zoom_user_id ||
    chosen?.user_id ||
    chosen?.owner_id ||
    undefined;
  const dir = String(chosen?.direction || o.direction || "").toLowerCase() || "unknown";

  const talkSecCand = chosen?.talk_time ?? o.talk_time ?? chosen?.talkTime ?? o.talkTime;
  let ms = 0;
  if (typeof talkSecCand === "number" && isFinite(talkSecCand)) {
    ms = Math.max(0, Math.floor(talkSecCand * 1000));
  } else {
    const stIso = chosen?.start_time || o.start_time;
    const etIso = chosen?.end_time || o.end_time || chosen?.ended_at || o.ended_at;
    const st = stIso ? Date.parse(stIso) : NaN;
    const et = etIso ? Date.parse(etIso) : NaN;
    if (Number.isFinite(st) && Number.isFinite(et)) ms = Math.max(0, et - st);
    else ms = 0;
  }
  if (ms < 0) ms = 0;
  if (ms > 3 * 60 * 60 * 1000) ms = 3 * 60 * 60 * 1000; // 3h guard

  const callId =
    o.call_id || o.session_id || chosen?.call_id || chosen?.session_id || `zoom:${Date.now()}`;
  const endIso = chosen?.end_time || o.end_time || chosen?.ended_at || o.ended_at;
  const endedAt = Number.isFinite(Date.parse(endIso)) ? Date.parse(endIso) : Date.now();

  return { email, zid, dir, ms, callId, endedAt };
}

export async function zoomWebhook(req: Request & { rawBody?: Buffer }, res: Response) {
  // 1) ボディの復元（Zoom 署名検証や URL 検証で必要）
  const rawText = req.rawBody ? req.rawBody.toString("utf8") : undefined;
  let b: any = (req as any).body || {};
  if (!b || (Object.keys(b).length === 0 && rawText)) {
    try {
      b = JSON.parse(rawText!);
    } catch {
      /* noop */
    }
  }

  // 2) URL 検証イベントは従来通り即時に応答
  const plain = b?.plainToken || b?.payload?.plainToken || b?.event?.plainToken;
  if (plain) {
    const key = ZOOM_WEBHOOK_SECRET || AUTH_TOKEN || "dummy";
    const enc = crypto.createHmac("sha256", key).update(String(plain)).digest("hex");
    return res.json({ plainToken: String(plain), encryptedToken: enc });
  }

  // 3) 認証は同期で判定（不正なら 401 を即返す）
  let ok = false;
  if (req.get("x-zm-signature")) ok = verifyZoomSignature(req).ok;
  if (!ok) {
    const expected = ZOOM_BEARER_TOKEN || ZOOM_WEBHOOK_SECRET || AUTH_TOKEN || "";
    if (expected && readBearerFromHeaders(req) === expected) ok = true;
  }
  if (!ok) return res.status(401).json({ ok: false, error: "auth" });

  // 4) ここで即 ACK（Zoom は 3 秒以内に 200 が必要）
  try {
    res.status(200).end();
  } catch {
    // 念のため握りつぶす
  }

  // 5) 以降は非同期で従来処理を実行（元の機能は一切削らない）
  setImmediate(async () => {
    try {
      const obj = b?.payload?.object || b?.object || {};
      const info = pickZoomInfo(obj);
      const resolvedEmail = info.email || (info.zid && ZOOM_UID2MAIL[String(info.zid)]) || undefined;
      const ts = b.timestamp || info.endedAt || Date.now();

      if (String(info.dir) === "inbound") {
        // 受電は XP 付与対象外：記録のみ
        const when = fmtJST(ts);
        log(`[call] inbound (no XP) by=担当者 ${when}`);
        appendJsonl("data/events/calls.jsonl", {
          at: new Date().toISOString(),
          day: isoDay(ts),
          callId: info.callId,
          ms: info.ms || 0,
          dir: info.dir || "inbound",
          actor: { name: "担当者", email: resolvedEmail },
        });
        return;
      }

      // 発信：通話時間に応じた XP 付与
      await awardXpForCallDuration({
        source: "zoom",
        eventId: b.event_id || info.callId,
        callId: info.callId,
        durationMs: inferDurationMs(info.ms),
        occurredAt: ts,
        raw: { userEmail: resolvedEmail },
      });
      log(`[zoom] handled outbound call callId=${info.callId} ms=${info.ms}`);
    } catch (e: any) {
      log(`[zoom][post-ack-error] ${e?.stack || e?.message || String(e)}`);
    }
  });
}
