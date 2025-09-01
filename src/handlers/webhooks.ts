import type { Request, Response, NextFunction, Express } from "express";
import { Router } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * v3署名シークレット（両対応）
 * 1) Private App: HUBSPOT_WEBHOOK_SIGNING_SECRET
 * 2) Developer/Public App: HUBSPOT_CLIENT_SECRET
 *    ※ 両方ある場合は Signing secret を優先
 */
const HUBSPOT_SECRET =
  process.env.HUBSPOT_WEBHOOK_SIGNING_SECRET ||
  process.env.HUBSPOT_CLIENT_SECRET ||
  "";

/** 署名時刻の許容スキュー（ms） */
const TS_SKEW_MS = 5 * 60 * 1000;

/** 簡易デデュープ（メモリ, TTL 15分） */
const SEEN_TTL_MS = 15 * 60 * 1000;
const seen = new Map<string, number>();
function dedupe(key: string): boolean {
  const now = Date.now();
  for (const [k, t] of seen) {
    if (now - t > SEEN_TTL_MS) seen.delete(k);
  }
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

/** timing-safe 比較 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a || "", "utf8");
  const bb = Buffer.from(b || "", "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** rawBody を取得（なければ JSON.stringify(body) で代替） */
function getRawBody(req: Request): string {
  const anyReq = req as any;
  if (typeof anyReq.rawBody === "string") return anyReq.rawBody;
  if (typeof req.body === "string") return req.body;
  try { return JSON.stringify(req.body ?? ""); } catch { return ""; }
}

/** v3署名検証：method + uri + body + timestamp → HMAC-SHA256 → Base64 */
function verifyHubSpotV3(req: Request, rawBody: string): boolean {
  if (!HUBSPOT_SECRET) return false;

  const method = (req.method || "POST").toUpperCase();
  // 署名対象のURIは「パスのみ」（クエリ除外）
  const uri = (req.originalUrl || req.url || "").split("?")[0] || "/webhooks/hubspot";

  const tsHeader = req.get("X-HubSpot-Request-Timestamp") || "";
  const sigHeader = req.get("X-HubSpot-Signature-v3") || "";
  if (!tsHeader || !sigHeader) return false;

  const ts = Number(tsHeader);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() - ts) > TS_SKEW_MS) return false;

  const base = `${method}${uri}${rawBody}${tsHeader}`;
  const expected = crypto.createHmac("sha256", HUBSPOT_SECRET).update(base).digest("base64");

  return safeEqual(sigHeader, expected);
}

/** JSONL追記 */
function appendJsonl(filePath: string, obj: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
}

/** Webhook本体：HubSpot */
async function handleHubSpotWebhook(req: Request, res: Response, _next: NextFunction) {
  try {
    const raw = getRawBody(req);
    if (!verifyHubSpotV3(req, raw)) {
      // 署名NG時は 404（観測性を下げる）
      return res.status(404).json({ ok: false });
    }

    const payload = Array.isArray(req.body) ? req.body : [];
    let accepted = 0;

    for (const ev of payload) {
      const type = String(ev?.subscriptionType || "");
      const prop = String(ev?.propertyName || "");
      const val  = String(ev?.propertyValue || "");
      const objId = ev?.objectId ?? ev?.id ?? undefined; // dealId 等
      const occurredAtMs = Number(ev?.occurredAt || Date.now());
      const occurredAtIso = new Date(occurredAtMs).toISOString();

      // デデュープキー
      const dk = crypto
        .createHash("sha1")
        .update(`${req.get("X-HubSpot-Signature-v3") || ""}|${objId}|${prop}|${val}|${occurredAtMs}`)
        .digest("hex");
      if (dedupe(dk)) continue;

      // アポ新規（appointmentscheduled）を受理
      if (type === "deal.propertyChange" && prop === "dealstage" && /appointmentscheduled/i.test(val)) {
        // —— 恒久対応：award_from_events.ts が期待するキーに合わせる
        const apoId = String(objId ?? "");
        // ※ Owner はイベントに含まれないことが多いので、当面 SELF を付与
        //   本番では HubSpot API から owner を引いて users.yml にマップ予定
        const ownerId = String(ev?.ownerId || "SELF");

        appendJsonl(
          path.resolve("data/events/hubspot_appointments.jsonl"),
          {
            type: "new_appointment",
            apo_id: apoId,
            owner_id: ownerId,
            occurred_at: occurredAtIso,
            raw: ev
          }
        );
        accepted++;
      } else {
        // その他イベントは参考保存
        appendJsonl(
          path.resolve("data/events/hubspot_misc.jsonl"),
          { occurred_at: occurredAtIso, raw: ev }
        );
      }
    }

    return res.status(200).json({ ok: true, received: payload.length, accepted });
  } catch (err: any) {
    console.error("[hubspot webhook] handler error:", err?.stack || err?.message || err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
}

/** Router 形式 */
export const webhooksRouter = Router();
webhooksRouter.post("/webhooks/hubspot", handleHubSpotWebhook);

/** 直接登録用 */
export function registerWebhooks(app: Express) {
  app.post("/webhooks/hubspot", handleHubSpotWebhook);
}

export default webhooksRouter;
