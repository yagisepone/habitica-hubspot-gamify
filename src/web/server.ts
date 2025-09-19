// server.ts
import express, { Request, Response } from "express";
import crypto from "crypto";
import Busboy from "busboy"; // 将来の拡張用に残してOK
import { parse as csvParse } from "csv-parse/sync";
import fs from "fs";
import path from "path";

// =============== 基本 ===============
const app = express();
app.set("x-powered-by", false);
app.set("trust proxy", true);
app.use(
  express.json({
    verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
      (req as any).rawBody = Buffer.from(buf);
    },
  })
);
// CORS（/admin配下のみ）
app.use((req, res, next) => {
  if (req.path.startsWith("/admin/")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
  }
  next();
});

// =============== Utils ===============
function log(...a: any[]) { console.log("[web]", ...a); }
function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }
function appendJsonl(fp: string, obj: any) { ensureDir(path.dirname(fp)); fs.appendFileSync(fp, JSON.stringify(obj) + "\n"); }
function readJsonlAll(fp: string): any[] {
  try { return fs.readFileSync(fp, "utf8").trim().split("\n").filter(Boolean).map(s=>JSON.parse(s)); } catch { return []; }
}
function writeJson(fp: string, obj: any) { ensureDir(path.dirname(fp)); fs.writeFileSync(fp, JSON.stringify(obj, null, 2)); }
function readJson<T=any>(fp: string, fallback: T): T { try { return JSON.parse(fs.readFileSync(fp,"utf8")); } catch { return fallback; } }
function isoDay(d?: any) {
  const t = d ? new Date(d) : new Date();
  return t.toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).replace(/\//g,"-");
}
function fmtJST(ms?: any) {
  const n = Number(ms); if(!Number.isFinite(n)) return "-";
  return new Date(n).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});
}
function timingEqual(a: string, b: string) {
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function readEnvJsonOrFile(jsonVar: string, fileVar: string): string {
  const j = (process.env as any)[jsonVar]; if (j && String(j).trim()) return String(j).trim();
  const fp = (process.env as any)[fileVar]; if (fp && String(fp).trim()) { try { return fs.readFileSync(String(fp).trim(),"utf8"); } catch {}
  }
  return "";
}
function safeParse<T=any>(s?: string): T|undefined { try { return s? JSON.parse(s) as T: undefined; } catch { return undefined; } }
function normSpace(s?: string){ return (s||"").replace(/\u3000/g," ").trim(); }
function requireBearer(req: Request, res: Response): boolean {
  const token = (req.header("authorization")||"").replace(/^Bearer\s+/i,"");
  if (!AUTH_TOKEN) { res.status(500).json({ok:false,error:"missing AUTH_TOKEN"}); return false; }
  if (token !== AUTH_TOKEN) { res.status(401).json({ok:false,error:"auth"}); return false; }
  return true;
}

// =============== 定数（安全弁） ===============
const MAX_CALL_MS = 3 * 60 * 60 * 1000; // 10,800,000ms（1コール上限）

// --- Zoom payload からメール/方向/長さ/ID を安全に抜く（仕様準拠） ---
function pickZoomInfo(obj: any) {
  const o = obj || {};
  const logs: any[] =
    Array.isArray(o.call_logs) ? o.call_logs :
    Array.isArray(o?.object?.call_logs) ? o.object.call_logs :
    [];

  // アウトバウンド優先で1件選ぶ（なければ先頭）
  const chosen =
    logs.find((x) => String(x?.direction || "").toLowerCase() === "outbound") ||
    logs[0] || o;

  // メール候補
  const emailRaw =
    o.user_email || o.owner_email || o.caller_email || o.callee_email ||
    chosen?.caller_email || chosen?.callee_email || "";
  const email = String(emailRaw || "").toLowerCase() || undefined;

  // user/owner のID（ZOOM_EMAIL_MAP_JSON 補完用）
  const zid =
    o.zoom_user_id || o.user_id || o.owner_id ||
    chosen?.zoom_user_id || chosen?.user_id || chosen?.owner_id || undefined;

  // 方向
  const dir = (String(chosen?.direction || o.direction || "").toLowerCase() || "unknown");

  // ====== 会話時間：talk_time（秒）最優先 ======
  const talkSecCand =
    chosen?.talk_time ?? o.talk_time ?? chosen?.talkTime ?? o.talkTime;

  let ms = 0;
  if (typeof talkSecCand === "number" && isFinite(talkSecCand)) {
    ms = Math.max(0, Math.floor(talkSecCand * 1000)); // 秒→ms
  } else {
    // 予備：start_time / end_time 差分（ISO文字列）
    const stIso = chosen?.start_time || o.start_time;
    const etIso = chosen?.end_time   || o.end_time   || chosen?.ended_at || o.ended_at;
    const st = stIso ? Date.parse(stIso) : NaN;
    const et = etIso ? Date.parse(etIso) : NaN;
    if (Number.isFinite(st) && Number.isFinite(et)) {
      ms = Math.max(0, et - st);
    } else {
      ms = 0; // 無効は0に落とす
    }
  }
  // 最終クランプ
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms > MAX_CALL_MS) ms = MAX_CALL_MS;

  // callId
  const callId =
    o.call_id || o.session_id || chosen?.call_id || chosen?.session_id ||
    `zoom:${Date.now()}`;

  // 終了時刻（epoch ms に正規化）
  const endIso = chosen?.end_time || o.end_time || chosen?.ended_at || o.ended_at;
  const endedAt = Number.isFinite(Date.parse(endIso)) ? Date.parse(endIso) : Date.now();

  return { email, zid, dir, ms, callId, endedAt };
}

// =============== ENV ===============
const PORT = Number(process.env.PORT || 10000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const DRY_RUN = String(process.env.DRY_RUN || "0") === "1";
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/+$/,"");

// HubSpot v3
const WEBHOOK_SECRET = process.env.HUBSPOT_WEBHOOK_SIGNING_SECRET || process.env.HUBSPOT_APP_SECRET || "";

// Zoom 署名
const ZOOM_WEBHOOK_SECRET = String(process.env.ZOOM_WEBHOOK_SECRET || process.env.ZOOM_SECRET || "").trim();
const ZOOM_VERIFICATION_TOKEN = String(process.env.ZOOM_VERIFICATION_TOKEN || process.env.ZOOM_VTOKEN || "").trim();
const ZOOM_BEARER_TOKEN = process.env.ZOOM_BEARER_TOKEN || "";
const ZOOM_SIG_SKEW = Number(process.env.ZOOM_SIG_SKEW || 300);

// だれ判定マップ
const HUBSPOT_USER_MAP_JSON = readEnvJsonOrFile("HUBSPOT_USER_MAP_JSON","HUBSPOT_USER_MAP_FILE");
const HABITICA_USERS_JSON = readEnvJsonOrFile("HABITICA_USERS_JSON","HABITICA_USERS_FILE");
const NAME_EMAIL_MAP_JSON  = readEnvJsonOrFile("NAME_EMAIL_MAP_JSON","NAME_EMAIL_MAP_FILE");
const ZOOM_EMAIL_MAP_JSON  = readEnvJsonOrFile("ZOOM_EMAIL_MAP_JSON","ZOOM_EMAIL_MAP_FILE");

// 架電XP
// ★ 累計モードは廃止。常に「コール内5分ごと」方式のみ。
const CALL_TOTALIZE_5MIN = false as const;
const CALL_XP_PER_CALL = (process.env.CALL_XP_PER_CALL === undefined || process.env.CALL_XP_PER_CALL === "")
  ? 1 : Number(process.env.CALL_XP_PER_CALL);
const CALL_XP_PER_5MIN   = Number(process.env.CALL_XP_PER_5MIN || 2);
const CALL_XP_UNIT_MS    = Number(process.env.CALL_XP_UNIT_MS || 300000);

// CSV UI 設定
const CSV_UPLOAD_TOKENS = String(process.env.CSV_UPLOAD_TOKENS || "").split(",").map(s=>s.trim()).filter(Boolean);

// 日報ボーナス: ENV
const DAILY_BONUS_XP = Number(process.env.DAILY_BONUS_XP || 10);
const DAILY_TASK_MATCH = String(process.env.DAILY_TASK_MATCH || "日報").split(",").map(s => s.trim()).filter(Boolean);
const HABITICA_WEBHOOK_SECRET = process.env.HABITICA_WEBHOOK_SECRET || AUTH_TOKEN || "";

// 新規アポ（仕様：+20XP＋バッジ）
const APPOINTMENT_XP = Number(process.env.APPOINTMENT_XP || 20);
const APPOINTMENT_BADGE_LABEL = process.env.APPOINTMENT_BADGE_LABEL || "🎯 新規アポ";
// 受理アウトカム（カンマ区切り、大小区別なし）
const APPOINTMENT_VALUES = String(process.env.APPOINTMENT_VALUES || "appointment_scheduled,新規アポ")
  .split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);

// =============== 外部コネクタ ===============
import {
  sendChatworkMessage,
  cwApptText,
  cwApprovalText,
  cwSalesText,
  cwMakerAchievementText,
} from "../connectors/chatwork.js";
import {
  createTodo,
  completeTask,
  addApproval,
  addSales,
  addMakerAward,
  addAppointment,
  addBadge,
} from "../connectors/habitica.js";

// =============== マップ構築 ===============
type HabiticaCred = { userId: string; apiToken: string };
function buildHabiticaMap(s: string){ const p = safeParse<Record<string,HabiticaCred>>(s)||{}; const out:Record<string,HabiticaCred>={}; for(const [k,v] of Object.entries(p)){ if(v?.userId && v?.apiToken) out[k.toLowerCase()]={userId:String(v.userId),apiToken:String(v.apiToken)}; } return out; }
function buildNameEmailMap(s: string){ const p = safeParse<Record<string,string>>(s)||{}; const out:Record<string,string>={}; for(const [n,e] of Object.entries(p)){ if(!n||!e) continue; out[normSpace(n)] = e.toLowerCase(); } return out; }
function buildZoomEmailMap(s: string){ const p = safeParse<Record<string,string>>(s)||{}; const out:Record<string,string>={}; for(const [z,e] of Object.entries(p)){ if(!z||!e) continue; out[z]=e.toLowerCase(); } return out; }
const HAB_MAP = buildHabiticaMap(HABITICA_USERS_JSON);
const NAME2MAIL = buildNameEmailMap(NAME_EMAIL_MAP_JSON);
const ZOOM_UID2MAIL = buildZoomEmailMap(ZOOM_EMAIL_MAP_JSON);
const getHabitica = (email?: string)=> email? HAB_MAP[email.toLowerCase()]: undefined;

// =============== 重複抑止 ===============
const seen = new Map<string, number>();
const DEDUPE_TTL_SEC = Number(process.env.DEDUPE_TTL_SEC || 24*60*60);
function hasSeen(id?: any){ if(id==null) return false; const key=String(id); const now=Date.now(); for(const [k,ts] of seen){ if(now-ts>DEDUPE_TTL_SEC*1000) seen.delete(k); } return seen.has(key); }
function markSeen(id?: any){ if(id==null) return; seen.set(String(id), Date.now()); }

// =============== Health/Support ===============
app.get("/healthz", (_req,res)=>{
  res.json({ ok:true, version:"2025-09-19-msfix-dxport1", tz:process.env.TZ||"Asia/Tokyo",
    now:new Date().toISOString(), baseUrl:PUBLIC_BASE_URL||null, dryRun:DRY_RUN,
    habiticaUserCount:Object.keys(HAB_MAP).length, nameMapCount:Object.keys(NAME2MAIL).length,
    apptValues: APPOINTMENT_VALUES, totalize: CALL_TOTALIZE_5MIN
  });
});
app.get("/support", (_req,res)=>res.type("text/plain").send("Support page"));

// =============== HubSpot v3 Webhook（署名検証） ===============
app.post("/webhooks/hubspot", async (req: Request & { rawBody?: Buffer }, res: Response)=>{
  const method = (req.method||"POST").toUpperCase();
  const withQuery = (req as any).originalUrl || (req as any).url || "/webhooks/hubspot";
  const urlObj = new URL(withQuery, "http://dummy.local");
  const pathOnly = urlObj.pathname + (urlObj.search||"");
  const tsHeader = req.header("x-hubspot-request-timestamp") || "";
  const sigHeader = req.header("x-hubspot-signature-v3") || "";
  const raw: Buffer = (req as any).rawBody ?? Buffer.from(JSON.stringify((req as any).body||""),"utf8");

  // 署名候補
  const proto = String(req.headers["x-forwarded-proto"]||"").split(",")[0].trim() || (req as any).protocol || "https";
  const hostHdr = String(req.headers["x-forwarded-host"]||req.headers["host"]||"").split(",")[0].trim();
  const candidates = new Set<string>();
  const add = (u:string)=>{ if(!u) return; candidates.add(u); candidates.add(u.endsWith("/")?u.slice(0,-1):u+"/"); };
  add(withQuery); add(pathOnly);
  if(hostHdr){ add(`${proto}://${hostHdr}${withQuery}`); add(`${proto}://${hostHdr}${pathOnly}`); }
  if(PUBLIC_BASE_URL){ add(new URL(withQuery, PUBLIC_BASE_URL).toString()); add(new URL(pathOnly, PUBLIC_BASE_URL).toString()); }

  const calc = Array.from(candidates).map(u=>{
    const base = Buffer.concat([Buffer.from(method), Buffer.from(u), raw, Buffer.from(tsHeader)]);
    const h = crypto.createHmac("sha256", WEBHOOK_SECRET).update(base).digest("base64");
    return { u, h };
  });
  const ok = calc.some(c=>timingEqual(c.h, sigHeader));
  res.status(204).end();

  let parsed:any=null; try{ parsed=JSON.parse(raw.toString("utf8")); } catch {}
  if (!ok || !Array.isArray(parsed)) return;

  for (const e of parsed) {
    const isCall = String(e.subscriptionType||"").toLowerCase().includes("call") || String(e.objectTypeId||"")==="0-48";
    if (isCall && e.propertyName==="hs_call_disposition") {
      await handleNormalizedEvent({ source:"v3", eventId:e.eventId??e.attemptNumber, callId:e.objectId, outcome:e.propertyValue, occurredAt:e.occurredAt, raw:e });
    }
    if (isCall && e.propertyName==="hs_call_duration") {
      const ms = inferDurationMs(e.propertyValue);
      await handleCallDurationEvent({ source:"v3", eventId:e.eventId??e.attemptNumber, callId:e.objectId, durationMs:ms, occurredAt:e.occurredAt, raw:e });
    }
  }
});

// =============== HubSpot Workflow（Bearerのみ） ===============
app.post("/webhooks/workflow", async (req: Request, res: Response)=>{
  if(!requireBearer(req,res)) return;
  const b:any = (req as any).body || {};
  const outcome = b.outcome || b.hs_call_disposition || b.properties?.hs_call_disposition;
  const callId = b.callId || b.engagementId || b.id;
  const occurredAt = b.endedAt || b.occurredAt || b.timestamp || b.properties?.hs_timestamp;
  await handleNormalizedEvent({ source:"workflow", eventId:b.eventId||callId, callId, outcome, occurredAt, raw:b });
  if (b.type==="call.duration") {
    const ms = inferDurationMs(b.durationMs ?? b.durationSec);
    await handleCallDurationEvent({ source:"workflow", eventId:b.eventId||callId||`dur:${Date.now()}`, callId:callId||b.id, durationMs:ms, occurredAt, raw:b });
  }
  res.json({ok:true});
});

// =============== Zoom Webhook（ts+base64 / HEXのみ 両対応） ===============
function readBearerFromHeaders(req: Request){ for(const k of ["authorization","x-authorization","x-auth","x-zoom-authorization","zoom-authorization"]) { const v=req.get(k); if(!v) continue; const m=v.trim().match(/^Bearer\s+(.+)$/i); return (m?m[1]:v).trim(); } return ""; }
function verifyZoomSignature(req: Request & { rawBody?: Buffer }){
  const header = req.get("x-zm-signature") || "";
  if(!header) return { ok:false, why:"no_header" };
  const body = (req.rawBody ?? Buffer.from("", "utf8")).toString("utf8");

  // HEXのみ variant
  const mHex = header.match(/^v0=([a-f0-9]{64})$/i);
  if (mHex) {
    const sigHex = mHex[1].toLowerCase();
    const eq = (hex:string)=>{ try{ return crypto.timingSafeEqual(Buffer.from(sigHex,"hex"), Buffer.from(hex,"hex")); }catch{return false;} };
    if (ZOOM_VERIFICATION_TOKEN) {
      const vt = crypto.createHmac("sha256", ZOOM_VERIFICATION_TOKEN).update(body).digest("hex");
      if (eq(vt)) return { ok:true, variant:"hex_vtoken" };
    }
    if (ZOOM_WEBHOOK_SECRET) {
      const h1 = crypto.createHmac("sha256", ZOOM_WEBHOOK_SECRET).update(body).digest("hex");
      const h2 = crypto.createHmac("sha256", ZOOM_WEBHOOK_SECRET).update("v0"+body).digest("hex");
      const h3 = crypto.createHmac("sha256", ZOOM_WEBHOOK_SECRET).update("v0:"+body).digest("hex");
      if (eq(h1)||eq(h2)||eq(h3)) return { ok:true, variant:"hex_secret" };
    }
    return { ok:false, why:"signature_mismatch_hex" };
  }

  // v0:<ts>:<base64> / v0=<ts>:<base64>
  const m = header.match(/^v0[:=](\d+):([A-Za-z0-9+/=]+)$/);
  if(!m) return { ok:false, why:"bad_format" };
  const ts = Number(m[1]); const sig = m[2];
  const now = Math.floor(Date.now()/1000); if(Math.abs(now-ts) > ZOOM_SIG_SKEW) return { ok:false, why:"timestamp_skew" };
  if(!ZOOM_WEBHOOK_SECRET) return { ok:false, why:"no_secret" };

  const macA = crypto.createHmac("sha256", ZOOM_WEBHOOK_SECRET).update(String(ts)+body).digest("base64");
  const macB = crypto.createHmac("sha256", ZOOM_WEBHOOK_SECRET).update(`v0:${ts}:${body}`).digest("base64");
  const eqB64 = (mac:string)=>{ try{ return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sig)); }catch{return false;} };
  return { ok: eqB64(macA)||eqB64(macB), variant:"v0_ts_b64" };
}

app.post("/webhooks/zoom", async (req: Request & { rawBody?: Buffer }, res: Response)=>{
  const rawText = req.rawBody? req.rawBody.toString("utf8"): undefined;
  let b:any = (req as any).body || {};
  if(!b || (Object.keys(b).length===0 && rawText)) { try{ b=JSON.parse(rawText!);}catch{} }

  // URL検証
  const plain = b?.plainToken || b?.payload?.plainToken || b?.event?.plainToken;
  if(plain){
    const key = ZOOM_WEBHOOK_SECRET || AUTH_TOKEN || "dummy";
    const enc = crypto.createHmac("sha256", key).update(String(plain)).digest("hex");
    return res.json({ plainToken:String(plain), encryptedToken:enc });
  }

  // 認証
  let ok = false;
  if (req.get("x-zm-signature")) ok = verifyZoomSignature(req).ok;
  if (!ok) {
    const expected = ZOOM_BEARER_TOKEN || ZOOM_WEBHOOK_SECRET || AUTH_TOKEN || "";
    if (expected && readBearerFromHeaders(req) === expected) ok = true;
  }
  if(!ok) return res.status(401).json({ok:false,error:"auth"});

  // ==== Zoomの実データ処理 ====
  const obj = b?.payload?.object || b?.object || {};
  const info = pickZoomInfo(obj);
  const resolvedEmail = info.email || (info.zid && ZOOM_UID2MAIL[String(info.zid)]) || undefined;

  // 着信はスキップ（記録のみ）
  if (String(info.dir) === "inbound") {
    log(`[call] inbound (no XP) by=担当者 ${fmtJST(b.timestamp || info.endedAt || Date.now())}`);
    appendJsonl("data/events/calls.jsonl", {
      at: new Date().toISOString(),
      day: isoDay(b.timestamp || info.endedAt),
      callId: info.callId,
      ms: info.ms || 0,
      dir: info.dir || "inbound",
      actor: { name: "担当者", email: resolvedEmail },
    });
    return res.json({ ok: true, accepted: true, inbound: true });
  }

  // 発信のみXP（0秒でも +1XP は必ず付与）
  log(`[zoom] accepted event=${b?.event || "unknown"} callId=${info.callId} ms=${info.ms||0} dir=${info.dir||"unknown"}`);
  await handleCallDurationEvent({
    source: "zoom",
    eventId: b.event_id || info.callId,
    callId: info.callId,
    durationMs: inferDurationMs(info.ms),
    occurredAt: b.timestamp || info.endedAt || Date.now(),
    raw: { userEmail: resolvedEmail },
  });
  return res.json({ ok:true, accepted:true, ms: info.ms || 0, dir: info.dir || "unknown" });
});

// =============== 正規化処理 & だれ特定 ===============
type Normalized = { source:"v3"|"workflow"; eventId?:any; callId?:any; outcome?:string; occurredAt?:any; raw?:any; };
function extractDxPortNameFromText(_s?: string): string|undefined { return undefined; } // 仕様外なら未使用
function resolveActor(ev:{source:"v3"|"workflow"|"zoom"; raw?:any}):{name:string; email?:string}{
  const raw = ev.raw||{};
  let email: string|undefined =
    raw.actorEmail || raw.ownerEmail || raw.userEmail || raw?.owner?.email || raw?.properties?.hs_created_by_user_id?.email || raw?.userEmail;

  const zid = raw.zoomUserId || raw.zoom_user_id || raw.user_id || raw.owner_id || raw.actorId || raw.userId;
  if(!email && zid && ZOOM_UID2MAIL[String(zid)]) email = ZOOM_UID2MAIL[String(zid)];

  const hsUserId = raw.hsUserId || raw.createdById || raw.actorId || raw.userId;
  const hsMap = safeParse<Record<string,{name?:string; email?:string}>>(HUBSPOT_USER_MAP_JSON);
  const mapped = hsUserId && hsMap ? hsMap[String(hsUserId)] : undefined;

  const display = (mapped?.name) || (email?String(email).split("@")[0]: undefined) || "担当者";
  const finalEmail = (email || mapped?.email || "").toLowerCase() || undefined;
  return { name: display, email: finalEmail };
}

async function handleNormalizedEvent(ev: Normalized){
  const id = ev.eventId ?? ev.callId;
  if (hasSeen(id)) return; markSeen(id);

  const rawOutcome = String(ev.outcome || "").trim();
  const outcomeLc = rawOutcome.toLowerCase();
  const isAppt = !!rawOutcome && APPOINTMENT_VALUES.includes(outcomeLc);

  if (isAppt) {
    log(`[appt] matched outcome="${rawOutcome}" via APPOINTMENT_VALUES=${JSON.stringify(APPOINTMENT_VALUES)}`);
    await awardXpForAppointment(ev);
    await notifyChatworkAppointment(ev);
  } else {
    log(`non-appointment outcome=${rawOutcome||"(empty)"}`);
  }
}

// =============== Habitica付与（アポ） & Chatwork通知 ===============
async function awardXpForAppointment(ev: Normalized){
  const who = resolveActor({source:ev.source as any, raw:ev.raw});
  const cred = getHabitica(who.email);
  const when = fmtJST(ev.occurredAt);

  appendJsonl("data/events/appointments.jsonl",{at:new Date().toISOString(),day:isoDay(ev.occurredAt),callId:ev.callId,actor:who});

  if (!cred || DRY_RUN) {
    log(`[XP] appointment +${APPOINTMENT_XP}XP (DRY_RUN or no-cred) callId=${ev.callId} by=${who.name} @${when}`);
    return;
  }

  try {
    // +20XP相当 & バッジ演出
    await addAppointment(cred, APPOINTMENT_XP, APPOINTMENT_BADGE_LABEL);
  } catch (e:any) {
    console.error("[appointment] habitica award failed:", e?.message||e);
  }
}

// Chatwork: スクショ準拠の短文
async function notifyChatworkAppointment(ev: Normalized){
  try {
    const who = resolveActor({source:ev.source as any, raw:ev.raw});
    await sendChatworkMessage(cwApptText(who.name));
  } catch {}
}

// =============== 通話（+1XP ＆ 5分ごとXP） ===============
type CallDurEv = { source:"v3"|"workflow"|"zoom"; eventId?:any; callId?:any; durationMs:number; occurredAt?:any; raw?:any; };

// ✅ 修正：ms/秒の誤判定を防ぐ安全版
function inferDurationMs(v:any){
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;

  // まず「ミリ秒っぽい値」を優先採用（MAX_CALL_MS 以下なら ms とみなす）
  if (n <= MAX_CALL_MS) {
    return Math.min(Math.floor(n), MAX_CALL_MS);
  }

  // 次に「秒っぽい値」（3時間以内の秒数）を ms に変換
  if (n <= MAX_CALL_MS / 1000) {
    return Math.min(Math.floor(n * 1000), MAX_CALL_MS);
  }

  // それ以外の巨大値は「既にms」と仮定してクランプ
  return Math.min(Math.floor(n), MAX_CALL_MS);
}

// “5分ごと加点（ベース抜き）”
function computePerCallExtra(ms:number){ return ms>0? Math.floor(ms/CALL_XP_UNIT_MS)*CALL_XP_PER_5MIN:0; }

async function awardXpForCallDuration(ev: CallDurEv){
  // ★ Zoom（通話）以外は付与しない（HubSpot経路などは記録のみ）
  if (ev.source !== "zoom") {
    console.log(`[call] skip non-zoom source=${ev.source} durMs=${ev.durationMs}`);
    return;
  }

  // 最終クランプ
  let durMs = Math.floor(Number(ev.durationMs||0));
  if (!Number.isFinite(durMs) || durMs < 0) durMs = 0;
  if (durMs > MAX_CALL_MS) durMs = MAX_CALL_MS;

  const when = fmtJST(ev.occurredAt);
  const who = resolveActor({source:ev.source as any, raw:ev.raw});

  // 仕様のデバッグ1行（関数冒頭）
  console.log(`[call] calc who=${who.email||who.name} durMs=${durMs} unit=${Number(process.env.CALL_XP_UNIT_MS ?? 300000)} per5=${Number(process.env.CALL_XP_PER_5MIN ?? 2)}`);

  appendJsonl("data/events/calls.jsonl",{at:new Date().toISOString(), day:isoDay(ev.occurredAt), callId:ev.callId, ms:durMs, actor:who});

  // 仕様：毎コール +1XP（0秒でも付与）
  if (CALL_XP_PER_CALL > 0) {
    const cred = getHabitica(who.email);
    if (!cred || DRY_RUN) {
      log(`[call] per-call base +${CALL_XP_PER_CALL}XP (DRY_RUN or no-cred) by=${who.name} @${when}`);
      console.log(`(+call) +${CALL_XP_PER_CALL}XP`);
    } else {
      const title = `📞 架電（${who.name}） +${CALL_XP_PER_CALL}XP`;
      const notes = `rule=per-call+${CALL_XP_PER_CALL}`;
      try {
        const todo = await createTodo(title, notes, undefined, cred);
        const id = (todo as any)?.id;
        if (id) await completeTask(id, cred);
        console.log(`(+call) +${CALL_XP_PER_CALL}XP`);
      } catch(e:any){
        console.error("[call] per-call habitica failed:", e?.message||e);
      }
    }
  }

  // ガード：MAX_CALL_MS ちょうど（または超えた結果でクランプ）になった通話は「長時間異常」の可能性があるので5分加点は抑止
  if (durMs >= MAX_CALL_MS) {
    console.log("[call] guard: durMs hit MAX_CALL_MS; suppress 5min extra, keep +1XP only");
    return;
  }

  // B) コール内で5分ごと +2XP（コール終了でリセット）
  const xpExtra = computePerCallExtra(durMs);
  if (xpExtra<=0) return;
  const cred = getHabitica(who.email);
  if (!cred || DRY_RUN) {
    log(`[call] per-call extra (5min) xp=${xpExtra} (DRY_RUN or no-cred) by=${who.name} @${when}`);
    console.log(`(5分加点) +${xpExtra}XP`);
    return;
  }
  const title = `📞 架電（${who.name}） +${xpExtra}XP（5分加点）`;
  const notes = `extra: ${CALL_XP_PER_5MIN}×floor(${durMs}/${CALL_XP_UNIT_MS})`;
  try { const todo = await createTodo(title, notes, undefined, cred); const id=(todo as any)?.id; if(id) await completeTask(id, cred); console.log(`(5分加点) +${xpExtra}XP`); } catch(e:any){ console.error("[call] habitica extra failed:", e?.message||e); }
}

async function handleCallDurationEvent(ev: CallDurEv){
  const id = ev.eventId ?? ev.callId ?? `dur:${ev.durationMs}`;
  if (hasSeen(id)) return; markSeen(id);
  await awardXpForCallDuration(ev); // ★ durationMs=0 でも per-call +1XP のため実行
}

// =============== CSV（承認・売上・メーカー賞 取り込み：自動マッピング対応） ===============
function truthyJP(v: any) {
  const s = String(v ?? "").trim().toLowerCase();
  return ["1","true","yes","y","on","済","◯","〇","ok","承認","approved","done"].some(t => s.includes(t));
}
function numOrUndefined(v:any){
  if (v==null) return undefined;
  const n = Number(String(v).replace(/[^\d.-]/g,""));
  return Number.isFinite(n) ? n : undefined;
}
function firstMatchKey(row: any, candidates: string[]): string|undefined {
  const keys = Object.keys(row||{});
  const lc = (x:string)=>x.toLowerCase().replace(/\s+/g,"");
  const set = new Map(keys.map(k=>[lc(k),k]));
  for (const c of candidates) {
    const m = set.get(lc(c));
    if (m) return m;
  }
  // 前方一致も許容
  for (const key of keys) {
    const k = lc(key);
    if (candidates.some(c => k.includes(lc(c)))) return key;
  }
  return undefined;
}

// ====== DXPortの◯◯ → 社内担当者名 → email 解決（強化版） ======
const DXPORT_NAME_KEYS = [
  "承認条件 回答23",
  "承認条件[回答23]",
  "承認条件_回答23",
  "DXPortの獲得者の名前",
  "DxPortの獲得者の名前",
  "DX PORT 獲得者の名前",
  "DXPort 獲得者の名前",
  "獲得者",
  "担当者名",
];
function stripDxPortPrefix(s: string){
  const t = normSpace(s);
  return t.replace(/^(dx\s*port|dxport)\s*の?/i, "").trim();
}
function resolveEmailFromRowByName(row: any): string | undefined {
  const keys = Object.keys(row || {});
  const lc = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  const keyMap = new Map(keys.map(k => [lc(k), k]));
  for (const cand of DXPORT_NAME_KEYS) {
    const hit = keyMap.get(lc(cand));
    if (!hit) continue;
    const raw = String(row[hit] ?? "").trim();
    if (!raw) continue;

    const name0 = stripDxPortPrefix(raw);
    if (!name0) continue;

    const mail = NAME2MAIL[name0];
    if (mail) return mail;

    // 緩和一致（部署/役職が混在するケースの保険）
    const norm = (s: string) => s.replace(/\s+/g, "");
    const target = norm(name0);
    for (const [n, e] of Object.entries(NAME2MAIL)) {
      const nn = norm(n);
      if (target.includes(nn) || nn.includes(target)) return e;
    }
  }
  return undefined;
}

/**
 * 任意スキーマCSV -> 標準レコード配列に正規化
 * 標準レコード: { type:'approval'|'sales'|'maker', email?, amount?, maker?, id?, date? }
 * 1行から複数typeを生成可（例: メーカー成果→ maker + approval）
 */
function normalizeCsv(text: string){
  const recs:any[] = csvParse(text,{ columns:true, bom:true, skip_empty_lines:true, trim:true, relax_column_count:true });

  // よくある見出しの候補（拡張）
  const C_EMAIL  = ["email","mail","担当者メール","担当者 メールアドレス","担当メール","担当者email","owner email","ユーザー メール","担当者のメール","担当メールアドレス"];
  const C_MAKER  = ["メーカー","メーカー名","メーカー名（取引先）","brand","maker","メーカー/サービス/プラン名","メーカー名/ブランド"];
  const C_AMOUNT = ["金額","売上","受注金額","金額(円)","amount","price","契約金額","成約金額","報酬","追加報酬"];
  const C_ID     = ["id","ID","案件ID","取引ID","レコードID","社内ID","番号"];
  const C_DATE   = ["date","日付","作成日","成約日","承認日","登録日","received at","created at","商談開始日","商談終了日"];
  const C_APPROV = ["承認","承認済み","approval","approved","ステータス","結果","商談ステータス"];
  const C_TYPE   = ["type","種別","イベント種別"];

  const out: Array<{type:"approval"|"sales"|"maker"; email?:string; amount?:number; maker?:string; id?:string; date?:string; notes?:string}> = [];

  for (const r of recs) {
    // まず、標準スキーマ(type,email,amount,maker,id,date,notes)に合っていればそのまま採用
    if (r.type || r.email || r.amount || r.maker) {
      const t = String(r.type||"").trim().toLowerCase();
      if (["approval","sales","maker"].includes(t)) {
        let emailStd = r.email? String(r.email).toLowerCase(): undefined;
        if (!emailStd) emailStd = resolveEmailFromRowByName(r); // ★ 補完
        out.push({
          type: t as any,
          email: emailStd,
          amount: numOrUndefined(r.amount),
          maker: r.maker? String(r.maker).trim(): undefined,
          id: r.id? String(r.id).trim(): undefined,
          date: r.date? String(r.date).trim(): undefined,
          notes: r.notes? String(r.notes): undefined,
        });
        continue;
      }
    }

    // 自由形式ヘッダから推定
    const kEmail  = firstMatchKey(r, C_EMAIL);
    const kMaker  = firstMatchKey(r, C_MAKER);
    const kAmt    = firstMatchKey(r, C_AMOUNT);
    const kId     = firstMatchKey(r, C_ID);
    const kDate   = firstMatchKey(r, C_DATE);
    const kApf    = firstMatchKey(r, C_APPROV);
    const kType   = firstMatchKey(r, C_TYPE);

    let email = kEmail ? String(r[kEmail]||"").toLowerCase().trim() : undefined;
    if (!email) email = resolveEmailFromRowByName(r); // ★ DXPort系の名前→メール補完

    const maker = kMaker ? String(r[kMaker]||"").trim() : undefined;
    const amount = kAmt ? numOrUndefined(r[kAmt]) : undefined;
    const rid = kId ? String(r[kId]||"").trim() : undefined;
    const date = kDate ? String(r[kDate]||"").trim() : undefined;

    // type列の指定があれば優先
    let explicitType: "approval"|"sales"|"maker"|undefined;
    if (kType) {
      const t = String(r[kType]||"").trim().toLowerCase();
      if (["approval","sales","maker"].includes(t)) explicitType = t as any;
    }

    // 承認フラグっぽい列
    const approved = kApf ? truthyJP(r[kApf]) : false;

    // 生成ルール
    if (explicitType === "sales" || (explicitType===undefined && amount && amount>0)) {
      out.push({ type:"sales", email, amount, maker, id: rid, date, notes:"from CSV(auto)" });
      continue;
    }
    if (explicitType === "approval" || approved) {
      out.push({ type:"approval", email, maker, id: rid, date, notes:"from CSV(auto)" });
      continue;
    }
    if (explicitType === "maker" || maker) {
      out.push({ type:"maker",   email, maker, id: rid, date, notes:"from CSV(auto)" });
      out.push({ type:"approval",email, maker, id: rid, date, notes:"from CSV(auto,maker-as-approval)" });
      continue;
    }
  }
  return out;
}

function requireBearerCsv(req: Request, res: Response): boolean {
  const token = (req.header("authorization")||"").replace(/^Bearer\s+/i,"");
  if (!AUTH_TOKEN && CSV_UPLOAD_TOKENS.length===0) { res.status(500).json({ok:false,error:"missing tokens"}); return false; }
  if (token===AUTH_TOKEN) return true;
  if (CSV_UPLOAD_TOKENS.includes(token)) return true;
  res.status(401).json({ok:false,error:"auth"}); return false;
}

app.post("/admin/csv", express.text({ type:"text/csv", limit:"20mb" }));
app.post("/admin/csv", async (req: Request, res: Response)=>{
  if(!requireBearerCsv(req,res)) return;
  const text = String((req as any).body||"");

  // 標準 or 自由形式を吸収
  const normalized = normalizeCsv(text);

  let nA=0, nS=0, nM=0, sum=0;
  for (const r of normalized) {
    const type = r.type;
    const email = r.email ? String(r.email).toLowerCase() : undefined;
    const amount = r.amount != null ? Number(r.amount) : undefined;
    const maker = r.maker ? String(r.maker).trim() : undefined;
    const id = String(r.id || `${type}:${email||"-"}:${maker||"-"}`).trim();
    const date = r.date ? String(r.date) : undefined;

    if (type==="approval") {
      nA++;
      appendJsonl("data/events/approvals.jsonl",{
        at:new Date().toISOString(), day:isoDay(date), email,
        actor: email? {name: email.split("@")[0], email}: undefined,
        id, maker
      });
      const cred = getHabitica(email);
      if (!DRY_RUN && cred) await addApproval(cred, 1, "CSV");
      // Chatwork 通知（承認）
      try {
        const actorName = email ? (email.split("@")[0]) : "担当者";
        await sendChatworkMessage(cwApprovalText(actorName, maker));
      } catch {}
    }

    if (type==="sales") {
      nS++; sum+=(amount||0);
      appendJsonl("data/events/sales.jsonl",{
        at:new Date().toISOString(), day:isoDay(date), email,
        actor: email? {name: email.split("@")[0], email}: undefined,
        id, maker, amount
      });
      const cred = getHabitica(email);
      if (!DRY_RUN && cred && amount) await addSales(cred, amount, "CSV");
      // Chatwork 通知（売上）
      try {
        const actorName = email ? (email.split("@")[0]) : "担当者";
        await sendChatworkMessage(cwSalesText(actorName, amount, maker));
      } catch {}
    }

    if (type==="maker") {
      nM++;
      appendJsonl("data/events/maker.jsonl",{
        at:new Date().toISOString(), day:isoDay(date), email,
        actor: email? {name: email.split("@")[0], email}: undefined,
        id, maker
      });
      const cred = getHabitica(email);
      if (!DRY_RUN && cred) {
        await addMakerAward(cred,1); // 🏆メーカー賞 + 記念バッジ
      }
      // Chatwork 通知（メーカー別成果）
      try {
        const actorName = email ? (email.split("@")[0]) : "担当者";
        await sendChatworkMessage(
          cwMakerAchievementText(actorName, maker /* メーカー名 */)
        );
      } catch {}
    }
  }

  // === 追加: メーカー賞の自動判定 & 付与（当日承認ベース） ===
  try {
    const today = isoDay(); // 取り込み日を当日として扱う
    const approvals = readJsonlAll("data/events/approvals.jsonl").filter((x:any)=> x.day === today && x.maker);

    const makerCount = new Map<string, number>();
    for (const a of approvals) makerCount.set(a.maker, (makerCount.get(a.maker)||0)+1);

    if (makerCount.size > 0) {
      const max = Math.max(...Array.from(makerCount.values()));
      const topMakers = Array.from(makerCount.entries()).filter(([_,c])=>c===max).map(([m])=>m);

      const winners = new Set<string>();
      for (const a of approvals) {
        if (topMakers.includes(a.maker) && a.email) winners.add(a.email);
      }

      for (const email of winners) {
        const cred = getHabitica(email);
        if (!cred || DRY_RUN) {
          log(`[maker-award] skip (DRY_RUN or no-cred) email=${email} makers=${topMakers.join(",")}`);
          continue;
        }
        try {
          await addMakerAward(cred, 1);
          if (typeof (addBadge as any) === "function") {
            await addBadge(cred, "⚙メーカー賞", `top makers: ${topMakers.join(", ")}`);
          }
        } catch (e:any) {
          console.error("[maker-award] failed:", e?.message||e);
        }
      }

      try {
        const names = Array.from(winners).map(m => (m.split("@")[0]));
        await sendChatworkMessage(
          `[info][title]⚙メーカー賞（本日）[/title]最多メーカー: ${topMakers.join(", ")} / 受賞: ${names.join(", ")}[/info]`
        );
      } catch {}
    }
  } catch (e:any) {
    console.error("[maker-award] error:", e?.message||e);
  }

  try {
    await sendChatworkMessage(
      `[info][title]CSV取込[/title]承認 ${nA} / 売上 ${nS}(計¥${sum.toLocaleString()}) / メーカー ${nM}[/info]`
    );
  } catch {}

  res.json({
    ok:true,
    mode:"upsert",
    received: normalized.length,
    accepted:{approval:nA,sales:nS,maker:nM},
    totalSales: sum,
    duplicates: 0,
    errors: 0
  });
});

app.get("/admin/template.csv", (_req,res)=>{
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",'attachment; filename="template.csv"');
  res.send(
    "type,email,amount,maker,id,date,notes\n"+
    "approval,info@example.com,0,,A-001,2025-09-08,承認OK\n"+
    "sales,info@example.com,150000,,S-001,2025-09-08,受注\n"+
    "maker,info@example.com,,ACME,M-ACME-1,2025-09-08,最多メーカー\n"
  );
});

app.get("/admin/upload", (_req,res)=>{
  const html = `<!doctype html><meta charset="utf-8"/><title>CSV取込（手動）</title>
  <style>body{font-family:system-ui;max-width:860px;margin:2rem auto;padding:0 1rem}textarea{width:100%;min-height:160px}</style>
  <h1>CSV取込（手動）</h1>
  <p>標準形式 <code>type,email,amount,maker,id,date,notes</code> だけでなく、<b>日本語見出しの自由形式</b>も自動マッピングで取り込めます（例：メーカー名/担当者 メールアドレス/受注金額/承認 など）。</p>
  <div><label>Base URL</label> <input id="base" size="40" value="${PUBLIC_BASE_URL||""}"/>
       <label>AUTH_TOKEN</label> <input id="tok" size="40"/></div>
  <p><input type="file" id="file" accept=".csv,text/csv"/> <button id="upload">アップロード</button></p>
  <p><textarea id="csv" placeholder="ここにCSVを貼り付けても送信できます（自動マッピング対応）"></textarea></p>
  <p><button id="send">貼り付けCSVを送信</button></p>
  <pre id="out"></pre>
  <script>
    const qs=s=>document.querySelector(s); const out=qs('#out');
    function pr(x){ out.textContent= typeof x==='string'? x: JSON.stringify(x,null,2); }
    async function postCsvRaw(text){
      const base=qs('#base').value.trim(); const tok=qs('#tok').value.trim(); if(!base||!tok) return pr('Base/Tokenを入力');
      const r=await fetch(base.replace(/\\/$/,'')+'/admin/csv',{method:'POST',headers:{'Content-Type':'text/csv','Authorization':'Bearer '+tok},body:text});
      const t=await r.text(); try{ pr(JSON.parse(t)); }catch{ pr(t); }
    }
    async function postCsvFile(file){
      const base=qs('#base').value.trim(); const tok=qs('#tok').value.trim(); if(!base||!tok) return pr('Base/Tokenを入力');
      const fr=new FileReader(); fr.onload=()=>postCsvRaw(String(fr.result||'')); fr.readAsText(file);
    }
    qs('#send').onclick=()=>postCsvRaw(qs('#csv').value);
    qs('#upload').onclick=()=>{ const f=qs('#file').files[0]; if(!f) return pr('CSVファイルを選択'); postCsvFile(f); };
  </script>`;
  res.type("html").send(html);
});

// =============== ダッシュボード ===============
app.get("/admin/dashboard", (_req,res)=>{
  const today = isoDay(), yest = isoDay(new Date(Date.now()-86400000));
  const rd = (fp:string)=> readJsonlAll(fp);
  const calls = rd("data/events/calls.jsonl");
  const appts = rd("data/events/appointments.jsonl");
  const apprs = rd("data/events/approvals.jsonl");
  const sales = rd("data/events/sales.jsonl");

  function agg(day:string){
    const by:Record<string, any> = {};
    const nm = (a:any)=> a?.actor?.name || (a?.email?.split?.("@")[0]) || "担当者";
    for(const x of calls.filter(v=>v.day===day)){ const k=nm(x); by[k]??={name:k,calls:0,min:0,appts:0,apprs:0,sales:0}; by[k].calls+=1; by[k].min+=Math.round((x.ms||0)/60000); }
    for(const x of appts.filter(v=>v.day===day)){ const k=nm(x); by[k]??={name:k,calls:0,min:0,appts:0,apprs:0,sales:0}; by[k].appts+=1; }
    for(const x of apprs.filter(v=>v.day===day)){ const k=nm(x); by[k]??={name:k,calls:0,min:0,appts:0,apprs:0,sales:0}; by[k].apprs+=1; }
    for(const x of sales.filter(v=>v.day===day)){ const k=nm(x); by[k]??={name:k,calls:0,min:0,appts:0,apprs:0,sales:0}; by[k].sales+=Number(x.amount||0); }
    for(const k of Object.keys(by)){ const v=by[k]; v.rate = v.appts>0? Math.round((v.apprs/v.appts)*100):0; }
    return Object.values(by).sort((a:any,b:any)=>a.name.localeCompare(b.name));
  }

  function aggMakers(day:string){
    const by:Record<string,{maker:string;count:number;sales:number}> = {};
    for(const x of apprs.filter(v=>v.day===day)){ const m=(x.maker||"").trim(); if(!m) continue; by[m]??={maker:m,count:0,sales:0}; by[m].count+=1; }
    for(const x of sales.filter(v=>v.day===day)){ const m=(x.maker||"").trim(); if(!m) continue; by[m]??={maker:m,count:0,sales:0}; by[m].sales+=Number(x.amount||0); }
    return Object.values(by).sort((a,b)=> b.count-a.count || b.sales-a.sales || a.maker.localeCompare(b.maker));
  }

  const T=agg(today), Y=agg(yest), TM=aggMakers(today), YM=aggMakers(yest);
  const Row = (r:any)=>`<tr><td>${r.name}</td><td style="text-align:right">${r.calls}</td><td style="text-align:right">${r.min}</td><td style="text-align:right">${r.appts}</td><td style="text-align:right">${r.apprs}</td><td style="text-align:right">${r.rate}%</td><td style="text-align:right">¥${(r.sales||0).toLocaleString()}</td></tr>`;
  const RowM= (r:any)=>`<tr><td>${r.maker}</td><td style="text-align:right">${r.count}</td><td style="text-align:right">¥${(r.sales||0).toLocaleString()}</td></tr>`;
  const html = `<!doctype html><meta charset="utf-8"><title>ダッシュボード</title>
  <style>body{font-family:system-ui;margin:2rem}table{border-collapse:collapse;min-width:760px}th,td{border:1px solid #ddd;padding:.45rem .55rem}th{background:#f7f7f7}h2{margin-top:2rem}</style>
  <h1>ダッシュボード</h1>
  <h2>本日 ${today}</h2>
  <table><thead><tr><th>担当</th><th>コール</th><th>分</th><th>アポ</th><th>承認</th><th>承認率</th><th>売上</th></tr></thead><tbody>${T.map(Row).join("")||'<tr><td colspan="7">データなし</td></tr>'}</tbody></table>
  <h2>メーカー別（承認ベース） 本日 ${today}</h2>
  <table><thead><tr><th>メーカー</th><th>承認数</th><th>売上(合計)</th></tr></thead><tbody>${TM.map(RowM).join("")||'<tr><td colspan="3">データなし</td></tr>'}</tbody></table>
  <h2>前日 ${yest}</h2>
  <table><thead><tr><th>担当</th><th>コール</th><th>分</th><th>アポ</th><th>承認</th><th>承認率</th><th>売上</th></tr></thead><tbody>${Y.map(Row).join("")||'<tr><td colspan="7">データなし</td></tr>'}</tbody></table>
  <h2>メーカー別（承認ベース） 前日 ${yest}</h2>
  <table><thead><tr><th>メーカー</th><th>承認数</th><th>売上(合計)</th></tr></thead><tbody>${YM.map(RowM).join("")||'<tr><td colspan="3">データなし</td></tr>'}</tbody></table>`;
  res.type("html").send(html);
});

// =============== 診断API（誰が誰に紐づいてるか） ===============
app.get("/admin/mapping", (req,res)=>{
  if(!requireBearer(req,res)) return;
  res.json({ ok:true, habiticaEmails:Object.keys(HAB_MAP).sort(), nameEmailEntries:Object.keys(NAME2MAIL).length, zoomUserIdMapCount:Object.keys(ZOOM_UID2MAIL).length });
});

// =============== 日報 Webhook（Habitica完了→+10XP） ===============
function isDailyTaskTitle(title?: string) {
  const t = String(title || "").trim();
  if (!t) return false;
  return DAILY_TASK_MATCH.some(k => t.includes(k));
}
function hasDailyBonusGiven(email: string, day: string) {
  const key = `daily:${day}:${email}`;
  return hasSeen(key);
}
function markDailyBonusGiven(email: string, day: string) {
  const key = `daily:${day}:${email}`;
  markSeen(key);
}

app.post("/webhooks/habitica", async (req: Request, res: Response) => {
  const token = String((req.query.t || req.query.token || "")).trim();
  if (!token || token !== HABITICA_WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: "auth" });
  }
  const email = String(req.query.email || "").toLowerCase();
  if (!email) return res.status(400).json({ ok: false, error: "missing email" });

  const body: any = (req as any).body || {};
  const task = body.task || body.data?.task || body.data || {};
  const text = String(task.text || task.title || "");
  const completed = task.completed === true || String(body.direction || "").toLowerCase() === "up";

  if (!isDailyTaskTitle(text) || !completed) {
    return res.json({ ok: true, skipped: true });
  }

  const day = isoDay();
  if (hasDailyBonusGiven(email, day)) {
    return res.json({ ok: true, duplicate: true });
  }

  const cred = getHabitica(email);
  if (!cred || DRY_RUN) {
    log(`[daily] +${DAILY_BONUS_XP}XP (DRY_RUN or no-cred) email=${email} task="${text}"`);
    appendJsonl("data/events/daily_bonus.jsonl", { at: new Date().toISOString(), day, email, task: text, dry_run: true });
    markDailyBonusGiven(email, day);
    return res.json({ ok: true, dryRun: true });
  }

  try {
    const title = `🗓日報ボーナス（${email.split("@")[0]}） +${DAILY_BONUS_XP}XP`;
    const notes = `rule=daily+${DAILY_BONUS_XP}\nsource=habitica_webhook\ntask="${text}"`;
    const todo = await createTodo(title, notes, undefined, cred);
    const id = (todo as any)?.id;
    if (id) await completeTask(id, cred);

    appendJsonl("data/events/daily_bonus.jsonl", { at: new Date().toISOString(), day, email, task: text });
    log(`[daily] +${DAILY_BONUS_XP}XP by=${email} task="${text}"`);
    markDailyBonusGiven(email, day);
    res.json({ ok: true, awarded: DAILY_BONUS_XP });
  } catch (e: any) {
    console.error("[daily] habitica award failed:", e?.message || e);
    res.status(500).json({ ok: false });
  }
});

// === Habitica Webhook を全員分に自動登録（管理API） ===
async function ensureHabiticaWebhook(email: string, cred: { userId: string; apiToken: string }) {
  if (!PUBLIC_BASE_URL) return { ok: false, why: "no PUBLIC_BASE_URL" };
  const base = "https://habitica.com/api/v3";
  const headers: any = {
    "x-api-user": cred.userId,
    "x-api-key": cred.apiToken,
    "content-type": "application/json",
  };
  const url = `${PUBLIC_BASE_URL.replace(/\/+$/,"")}/webhooks/habitica?t=${encodeURIComponent(HABITICA_WEBHOOK_SECRET)}&email=${encodeURIComponent(email)}`;

  // 既存一覧
  let list: any[] = [];
  try {
    const r = await fetch(`${base}/user/webhook`, { headers } as any);
    const js: any = await r.json().catch(() => ({}));
    list = Array.isArray(js?.data) ? js.data : [];
  } catch {}

  const exists = list.find((w: any) => w?.url === url && w?.label === "daily-bonus");
  if (exists) return { ok: true, existed: true };

  // 作成（type: "taskActivity"）
  const body = { url, label: "daily-bonus", type: "taskActivity" };
  const cr = await fetch(`${base}/user/webhook`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  } as any);
  const cj: any = await cr.json().catch(() => ({}));
  return { ok: !!cj?.success, created: true };
}

app.post("/admin/habitica/setup-webhooks", async (req: Request, res: Response) => {
  if (!requireBearer(req, res)) return;
  if (!HABITICA_WEBHOOK_SECRET) return res.status(400).json({ ok: false, error: "missing HABITICA_WEBHOOK_SECRET" });

  const results: any[] = [];
  for (const [email, cred] of Object.entries(HAB_MAP)) {
    try {
      const r = await ensureHabiticaWebhook(email, cred as any);
      results.push({ email, ...r });
    } catch (e: any) {
      results.push({ email, ok: false, error: e?.message || String(e) });
    }
  }
  res.json({ ok: true, results });
});

// =============== Start ===============
app.listen(PORT, ()=>{
  log(`listening :${PORT} DRY_RUN=${DRY_RUN} totalize=${CALL_TOTALIZE_5MIN} unit=${CALL_XP_UNIT_MS}ms per5min=${CALL_XP_PER_5MIN} perCall=${CALL_XP_PER_CALL}`);
  log(`[habitica] users=${Object.keys(HAB_MAP).length}, [name->email] entries=${Object.keys(NAME2MAIL).length}`);
  log(`[env] APPOINTMENT_XP=${APPOINTMENT_XP} DAILY_BONUS_XP=${DAILY_BONUS_XP}`);
  log(`[env] APPOINTMENT_VALUES=${JSON.stringify(APPOINTMENT_VALUES)}`);
});
export {};
