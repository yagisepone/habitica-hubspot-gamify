// server.ts
import express, { Request, Response } from "express";
import crypto from "crypto";
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
  const fp = (process.env as any)[fileVar]; if (fp && String(fp).trim()) { try { return fs.readFileSync(String(fp).trim(),"utf8"); } catch {} }
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
function toLocaleYen(n: number){ try { return n.toLocaleString("ja-JP"); } catch { return String(n); } }

// DRY_RUN時はCW送信を抑止
async function safeCW(message: string) {
  if (!message) return;
  if (DRY_RUN) { console.log("[chatwork][DRY_RUN]\n" + message); return; }
  try { await sendChatworkMessage(message); } catch (e:any) { console.error("[chatwork] send failed:", e?.message||e); }
}

// =============== 定数（安全弁） ===============
const MAX_CALL_MS = 3 * 60 * 60 * 1000; // 3h（1コール上限）

// --- Zoom payload からメール/方向/長さ/ID を安全に抜く ---
function pickZoomInfo(obj: any) {
  const o = obj || {};
  const logs: any[] =
    Array.isArray(o.call_logs) ? o.call_logs :
    Array.isArray(o?.object?.call_logs) ? o.object.call_logs :
    [];

  const chosen =
    logs.find((x) => String(x?.direction || "").toLowerCase() === "outbound") ||
    logs[0] || o;

  const emailRaw =
    o.user_email || o.owner_email || o.caller_email || o.callee_email ||
    chosen?.caller_email || chosen?.callee_email || "";
  const email = String(emailRaw || "").toLowerCase() || undefined;

  const zid =
    o.zoom_user_id || o.user_id || o.owner_id ||
    chosen?.zoom_user_id || chosen?.user_id || chosen?.owner_id || undefined;

  const dir = (String(chosen?.direction || o.direction || "").toLowerCase() || "unknown");

  // talk_time（秒）優先 → start/end 差分
  const talkSecCand =
    chosen?.talk_time ?? o.talk_time ?? chosen?.talkTime ?? o.talkTime;
  let ms = 0;
  if (typeof talkSecCand === "number" && isFinite(talkSecCand)) {
    ms = Math.max(0, Math.floor(talkSecCand * 1000));
  } else {
    const stIso = chosen?.start_time || o.start_time;
    const etIso = chosen?.end_time   || o.end_time   || chosen?.ended_at || o.ended_at;
    const st = stIso ? Date.parse(stIso) : NaN;
    const et = etIso ? Date.parse(etIso) : NaN;
    ms = (Number.isFinite(st) && Number.isFinite(et)) ? Math.max(0, et - st) : 0;
  }
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms > MAX_CALL_MS) ms = MAX_CALL_MS;

  const callId =
    o.call_id || o.session_id || chosen?.call_id || chosen?.session_id ||
    `zoom:${Date.now()}`;

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

// マップ
const HUBSPOT_USER_MAP_JSON = readEnvJsonOrFile("HUBSPOT_USER_MAP_JSON","HUBSPOT_USER_MAP_FILE");
const HABITICA_USERS_JSON = readEnvJsonOrFile("HABITICA_USERS_JSON","HABITICA_USERS_FILE");
const NAME_EMAIL_MAP_JSON  = readEnvJsonOrFile("NAME_EMAIL_MAP_JSON","NAME_EMAIL_MAP_FILE");
const ZOOM_EMAIL_MAP_JSON  = readEnvJsonOrFile("ZOOM_EMAIL_MAP_JSON","ZOOM_EMAIL_MAP_FILE");

// 架電XP
const CALL_XP_PER_CALL = (process.env.CALL_XP_PER_CALL === undefined || process.env.CALL_XP_PER_CALL === "")
  ? 1 : Number(process.env.CALL_XP_PER_CALL);
const CALL_XP_PER_5MIN   = Number(process.env.CALL_XP_PER_5MIN || 2);
const CALL_XP_UNIT_MS    = Number(process.env.CALL_XP_UNIT_MS || 300000);

// CSV UI 設定
const CSV_UPLOAD_TOKENS = String(process.env.CSV_UPLOAD_TOKENS || "").split(",").map(s=>s.trim()).filter(Boolean);

// 日報
const DAILY_BONUS_XP = Number(process.env.DAILY_BONUS_XP || 10);
const DAILY_TASK_MATCH = String(process.env.DAILY_TASK_MATCH || "日報").split(",").map(s => s.trim()).filter(Boolean);
const HABITICA_WEBHOOK_SECRET = process.env.HABITICA_WEBHOOK_SECRET || AUTH_TOKEN || "";

// 新規アポ
const APPOINTMENT_XP = Number(process.env.APPOINTMENT_XP || 20);
const APPOINTMENT_BADGE_LABEL = process.env.APPOINTMENT_BADGE_LABEL || "🎯 新規アポ";
const APPOINTMENT_VALUES = String(process.env.APPOINTMENT_VALUES || "appointment_scheduled,新規アポ")
  .split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);

// =============== 外部コネクタ ===============
import {
  sendChatworkMessage,
  cwApptText,
  cwApprovalText,
  cwSalesText,
} from "../connectors/chatwork";
import {
  createTodo,
  completeTask,
  addApproval,
  addSales,
  addMakerAward,
  addAppointment,
  addBadge,
} from "../connectors/habitica";

// =============== マップ構築 ===============
type HabiticaCred = { userId: string; apiToken: string };
function buildHabiticaMap(s: string){ const p = safeParse<Record<string,HabiticaCred>>(s)||{}; const out:Record<string,HabiticaCred>={}; for(const [k,v] of Object.entries(p)){ if(v?.userId && v?.apiToken) out[k.toLowerCase()]={userId:String(v.userId),apiToken:String(v.apiToken)}; } return out; }
function buildNameEmailMap(s: string){ const p = safeParse<Record<string,string>>(s)||{}; const out:Record<string,string>={}; for(const [n,e] of Object.entries(p)){ if(!n||!e) continue; out[normSpace(n)] = e.toLowerCase(); } return out; }
function buildZoomEmailMap(s: string){ const p = safeParse<Record<string,string>>(s)||{}; const out:Record<string,string>={}; for(const [z,e] of Object.entries(p)){ if(!z||!e) continue; out[z]=e.toLowerCase(); } return out; }
const HAB_MAP = buildHabiticaMap(HABITICA_USERS_JSON);
const NAME2MAIL = buildNameEmailMap(NAME_EMAIL_MAP_JSON);
const ZOOM_UID2MAIL = buildZoomEmailMap(ZOOM_EMAIL_MAP_JSON);
const getHabitica = (email?: string)=> email? HAB_MAP[email.toLowerCase()]: undefined;

// 人名表示（メール→人名逆引き優先）
function displayName(email?: string, fallback?: string) {
  if (email) {
    const ent = Object.entries(NAME2MAIL).find(([n, m]) => m === email.toLowerCase());
    if (ent) return ent[0];
  }
  return fallback || (email ? email.split("@")[0] : "担当者");
}
function nameToEmail(name?: string){ const n=normSpace(name||""); return n && NAME2MAIL[n] ? NAME2MAIL[n].toLowerCase() : undefined; }

// =============== 重複抑止 ===============
const seen = new Map<string, number>();
const DEDUPE_TTL_SEC = Number(process.env.DEDUPE_TTL_SEC || 24*60*60);
function hasSeen(id?: any){ if(id==null) return false; const key=String(id); const now=Date.now(); for(const [k,ts] of seen){ if(now-ts>DEDUPE_TTL_SEC*1000) seen.delete(k); } return seen.has(key); }
function markSeen(id?: any){ if(id==null) return; seen.set(String(id), Date.now()); }

// =============== Health ===============
app.get("/healthz", (_req,res)=>{
  res.json({ ok:true, version:"2025-09-19-maker-award-final2", tz:process.env.TZ||"Asia/Tokyo",
    now:new Date().toISOString(), baseUrl:PUBLIC_BASE_URL||null, dryRun:DRY_RUN,
    habiticaUserCount:Object.keys(HAB_MAP).length, nameMapCount:Object.keys(NAME2MAIL).length,
    apptValues: APPOINTMENT_VALUES
  });
});

// =============== HubSpot v3 Webhook ===============
app.post("/webhooks/hubspot", async (req: Request & { rawBody?: Buffer }, res: Response)=>{
  const method = (req.method||"POST").toUpperCase();
  const withQuery = (req as any).originalUrl || (req as any).url || "/webhooks/hubspot";
  const urlObj = new URL(withQuery, "http://dummy.local");
  const pathOnly = urlObj.pathname + (urlObj.search||"");
  const tsHeader = req.header("x-hubspot-request-timestamp") || "";
  const sigHeader = req.header("x-hubspot-signature-v3") || "";
  const raw: Buffer = (req as any).rawBody ?? Buffer.from(JSON.stringify((req as any).body||""),"utf8");

  const proto = String(req.headers["x-forwarded-proto"]||"").split(",")[0].trim() || (req as any).protocol || "https";
  const hostHdr = String(req.headers["x-forwarded-host"]||req.headers["host"]||"").split(",")[0].trim();
  const candidates = new Set<string>();
  const add = (u:string)=>{ if(!u) return; candidates.add(u); candidates.add(u.endsWith("/")?u.slice(0,-1):u+"/"); };
  add(withQuery); add(pathOnly);
  if(hostHdr){ add(`${proto}://${hostHdr}${withQuery}`); add(`${proto}://${hostHdr}${pathOnly}`); }
  if(PUBLIC_BASE_URL){ add(new URL(withQuery, PUBLIC_BASE_URL).toString()); add(new URL(pathOnly, PUBLIC_BASE_URL).toString()); }

  // 公式（method+url+body）／互換（+timestamp）両対応
  const calc = Array.from(candidates).map(u=>{
    const base1 = Buffer.concat([Buffer.from(method), Buffer.from(u), raw]);
    const h1 = crypto.createHmac("sha256", WEBHOOK_SECRET).update(base1).digest("base64");
    const base2 = Buffer.concat([Buffer.from(method), Buffer.from(u), raw, Buffer.from(tsHeader)]);
    const h2 = crypto.createHmac("sha256", WEBHOOK_SECRET).update(base2).digest("base64");
    return { u, h1, h2 };
  });
  const ok = calc.some(c=> timingEqual(c.h1, sigHeader) || timingEqual(c.h2, sigHeader));
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

// =============== HubSpot Workflow（Bearer） ===============
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

// =============== Zoom Webhook ===============
function readBearerFromHeaders(req: Request){ for(const k of ["authorization","x-authorization","x-auth","x-zoom-authorization","zoom-authorization"]) { const v=req.get(k); if(!v) continue; const m=v.trim().match(/^Bearer\s+(.+)$/i); return (m?m[1]:v).trim(); } return ""; }
function verifyZoomSignature(req: Request & { rawBody?: Buffer }){
  const header = req.get("x-zm-signature") || "";
  if(!header) return { ok:false, why:"no_header" };
  const body = (req.rawBody ?? Buffer.from("", "utf8")).toString("utf8");

  // HEX variant
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

  // 実データ
  const obj = b?.payload?.object || b?.object || {};
  const info = pickZoomInfo(obj);
  const resolvedEmail = info.email || (info.zid && ZOOM_UID2MAIL[String(info.zid)]) || undefined;

  // 着信は記録のみ
  if (String(info.dir) === "inbound") {
    log(`[call] inbound (no XP) by=${displayName(resolvedEmail)} ${fmtJST(b.timestamp || info.endedAt || Date.now())}`);
    appendJsonl("data/events/calls.jsonl", {
      at: new Date().toISOString(),
      day: isoDay(b.timestamp || info.endedAt),
      callId: info.callId,
      ms: info.ms || 0,
      dir: info.dir || "inbound",
      actor: { name: displayName(resolvedEmail), email: resolvedEmail },
    });
    return res.json({ ok: true, accepted: true, inbound: true });
  }

  // ★ 発信以外（unknown等）も記録のみ（XPなし）
  if (String(info.dir) !== "outbound") {
    log(`[call] non-outbound (no XP) dir=${info.dir||"unknown"} by=${displayName(resolvedEmail)} ${fmtJST(b.timestamp || info.endedAt || Date.now())}`);
    appendJsonl("data/events/calls.jsonl", {
      at: new Date().toISOString(),
      day: isoDay(b.timestamp || info.endedAt),
      callId: info.callId,
      ms: info.ms || 0,
      dir: info.dir || "unknown",
      actor: { name: displayName(resolvedEmail), email: resolvedEmail },
    });
    return res.json({ ok: true, accepted: true, nonOutbound: true });
  }

  // 発信のみXP
  log(`[zoom] accepted event=${b?.event || "unknown"} callId=${info.callId} ms=${info.ms||0} dir=${info.dir||"unknown"}`);
  await handleCallDurationEvent({
    source: "zoom",
    eventId: b.event_id || info.callId,
    callId: info.callId,
    durationMs: inferDurationMs(info.ms), // ← 修正済みの関数で秒/ミリ秒を安全判定
    occurredAt: b.timestamp || info.endedAt || Date.now(),
    raw: { userEmail: resolvedEmail },
  });
  return res.json({ ok:true, accepted:true, ms: info.ms || 0, dir: info.dir || "unknown" });
});

// =============== 正規化処理 & だれ特定 ===============
type Normalized = { source:"v3"|"workflow"; eventId?:any; callId?:any; outcome?:string; occurredAt?:any; raw?:any; };
function resolveActor(ev:{source:"v3"|"workflow"|"zoom"; raw?:any}):{name:string; email?:string}{
  const raw = ev.raw||{};
  let email: string|undefined =
    raw.actorEmail || raw.ownerEmail || raw.userEmail || raw?.owner?.email || raw?.properties?.hs_created_by_user_id?.email || raw?.userEmail;

  const zid = raw.zoomUserId || raw.zoom_user_id || raw.user_id || raw.owner_id || raw.actorId || raw.userId;
  if(!email && zid && ZOOM_UID2MAIL[String(zid)]) email = ZOOM_UID2MAIL[String(zid)];

  const hsUserId = raw.hsUserId || raw.createdById || raw.actorId || raw.userId;
  const hsMap = safeParse<Record<string,{name?:string; email?:string}>>(HUBSPOT_USER_MAP_JSON);
  const mapped = hsUserId && hsMap ? hsMap[String(hsUserId)] : undefined;

  const finalEmail = (email || mapped?.email || "").toLowerCase() || undefined;
  const display = displayName(finalEmail, mapped?.name);
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

  if (!cred) {
    log(`[XP] appointment +${APPOINTMENT_XP}XP (no-cred) callId=${ev.callId} by=${who.name} @${when}`);
    return;
  }

  try {
    await addAppointment(cred, APPOINTMENT_XP, APPOINTMENT_BADGE_LABEL);
    log(`[XP] appointment +${APPOINTMENT_XP}XP callId=${ev.callId} by=${who.name} @${when}`);
  } catch (e:any) {
    console.error("[appointment] habitica award failed:", e?.message||e);
  }
}

async function notifyChatworkAppointment(ev: Normalized){
  try {
    const who = resolveActor({source:ev.source as any, raw:ev.raw});
    await safeCW(cwApptText(who.name));
  } catch {}
}

// =============== 通話（+1XP ＆ 5分ごとXP） ===============
type CallDurEv = { source:"v3"|"workflow"|"zoom"; eventId?:any; callId?:any; durationMs:number; occurredAt?:any; raw?:any; };

// ★ 修正済み：1000未満は秒扱い／それ以上はms扱い
function inferDurationMs(v:any){
  const n = Number(v);
  if(!Number.isFinite(n) || n <= 0) return 0;
  const ms = n < 1000 ? Math.floor(n * 1000) : Math.floor(n);
  return Math.min(Math.max(0, ms), MAX_CALL_MS);
}
function computePerCallExtra(ms:number){ return ms>0? Math.floor(ms/CALL_XP_UNIT_MS)*CALL_XP_PER_5MIN:0; }

async function awardXpForCallDuration(ev: CallDurEv){
  if (ev.source !== "zoom") { // HubSpot経路は付与しない
    console.log(`[call] skip non-zoom source=${ev.source} durMs=${ev.durationMs}`);
    return;
  }

  let durMs = Math.floor(Number(ev.durationMs||0));
  if (!Number.isFinite(durMs) || durMs < 0) durMs = 0;
  if (durMs > MAX_CALL_MS) durMs = MAX_CALL_MS;

  const when = fmtJST(ev.occurredAt);
  const who = resolveActor({source:ev.source as any, raw:ev.raw});

  console.log(`[call] calc who=${who.email||who.name} durMs=${durMs} unit=${Number(process.env.CALL_XP_UNIT_MS ?? 300000)} per5=${Number(process.env.CALL_XP_PER_5MIN ?? 2)}`);

  appendJsonl("data/events/calls.jsonl",{at:new Date().toISOString(), day:isoDay(ev.occurredAt), callId:ev.callId, ms:durMs, actor:who});

  // +1XP（0秒でも）
  if (CALL_XP_PER_CALL > 0) {
    const cred = getHabitica(who.email);
    if (!cred) {
      log(`[call] per-call base +${CALL_XP_PER_CALL}XP (no-cred) by=${who.name} @${when}`);
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

  if (durMs >= MAX_CALL_MS) {
    console.log("[call] guard: durMs hit MAX_CALL_MS; suppress 5min extra, keep +1XP only");
    return;
  }

  const xpExtra = computePerCallExtra(durMs);
  if (xpExtra<=0) return;

  const cred = getHabitica(who.email);
  if (!cred) {
    log(`[call] per-call extra (5min) xp=${xpExtra} (no-cred) by=${who.name} @${when}`);
    console.log(`(5分加点) +${xpExtra}XP`);
    return;
  }
  const title = `📞 架電（${who.name}） +${xpExtra}XP（5分加点）`;
  const notes = `extra: ${CALL_XP_PER_5MIN}×floor(${durMs}/${CALL_XP_UNIT_MS})`;
  try {
    const todo = await createTodo(title, notes, undefined, cred);
    const id=(todo as any)?.id; if(id) await completeTask(id, cred);
    console.log(`(5分加点) +${xpExtra}XP`);
  } catch(e:any){
    console.error("[call] habitica extra failed:", e?.message||e);
  }
}
async function handleCallDurationEvent(ev: CallDurEv){
  const id = ev.eventId ?? ev.callId ?? `dur:${ev.durationMs}`;
  if (hasSeen(id)) return; markSeen(id);
  await awardXpForCallDuration(ev);
}

// =============== CSV（承認・売上・メーカー賞） ===============
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
  for (const key of keys) {
    const k = lc(key);
    if (candidates.some(c => k.includes(lc(c)))) return key;
  }
  return undefined;
}

// 任意スキーマCSV -> 標準レコード配列に正規化
function normalizeCsv(text: string){
  const recs:any[] = csvParse(text,{ columns:true, bom:true, skip_empty_lines:true, trim:true, relax_column_count:true });

  const C_EMAIL  = ["email","mail","担当者メール","担当者 メールアドレス","担当メール","担当者email","owner email","ユーザー メール"];
  const C_WINNER = ["承認条件 回答23（DX PORTの獲得者の名前）","承認条件 回答23（獲得者の名前）","獲得者","winner","担当者","担当","owner","獲得者の名前"];
  const C_MAKER  = ["メーカー","メーカー名","メーカー名（取引先）","brand","maker"];
  const C_AMOUNT = ["金額","売上","受注金額","金額(円)","amount","price","契約金額","成約金額"];
  const C_ID     = ["id","ID","案件ID","取引ID","レコードID","社内ID","番号"];
  const C_DATE   = ["date","日付","作成日","成約日","承認日","登録日","received at","created at"];
  const C_APPROV = ["承認","承認済み","approval","approved","ステータス","結果"];
  const C_TYPE   = ["type","種別","イベント種別"];

  const out: Array<{type:"approval"|"sales"|"maker"; email?:string; amount?:number; maker?:string; id?:string; date?:string; notes?:string; winnerName?:string}> = [];

  for (const r of recs) {
    if (r.type || r.email || r.amount || r.maker) {
      const t = String(r.type||"").trim().toLowerCase();
      if (["approval","sales","maker"].includes(t)) {
        out.push({
          type: t as any,
          email: r.email? String(r.email).toLowerCase(): undefined,
          amount: numOrUndefined(r.amount),
          maker: r.maker? String(r.maker).trim(): undefined,
          id: r.id? String(r.id).trim(): undefined,
          date: r.date? String(r.date).trim(): undefined,
          notes: r.notes? String(r.notes): undefined,
        });
        continue;
      }
    }

    const kEmail  = firstMatchKey(r, C_EMAIL);
    const kWinner = firstMatchKey(r, C_WINNER);
    const kMaker  = firstMatchKey(r, C_MAKER);
    const kAmt    = firstMatchKey(r, C_AMOUNT);
    const kId     = firstMatchKey(r, C_ID);
    const kDate   = firstMatchKey(r, C_DATE);
    const kApf    = firstMatchKey(r, C_APPROV);
    const kType   = firstMatchKey(r, C_TYPE);

    let email = kEmail ? String(r[kEmail]||"").toLowerCase().trim() : undefined;
    const winnerName = kWinner ? normSpace(String(r[kWinner]||"")) : undefined;
    if (!email && winnerName) email = nameToEmail(winnerName);

    const maker = kMaker ? String(r[kMaker]||"").trim() : undefined;
    const amount = kAmt ? numOrUndefined(r[kAmt]) : undefined;
    const rid = kId ? String(r[kId]||"").trim() : undefined;
    const date = kDate ? String(r[kDate]||"").trim() : undefined;

    let explicitType: "approval"|"sales"|"maker"|undefined;
    if (kType) {
      const t = String(r[kType]||"").trim().toLowerCase();
      if (["approval","sales","maker"].includes(t)) explicitType = t as any;
    }

    const approved = kApf ? truthyJP(r[kApf]) : false;

    if (explicitType === "sales" || (explicitType===undefined && amount && amount>0)) {
      out.push({ type:"sales", email, amount, maker, id: rid, date, notes:"from CSV(auto)", winnerName });
      continue;
    }
    if (explicitType === "approval" || approved) {
      out.push({ type:"approval", email, maker, id: rid, date, notes:"from CSV(auto)", winnerName });
      continue;
    }
    if (explicitType === "maker" || maker) {
      out.push({ type:"maker",   email, maker, id: rid, date, notes:"from CSV(auto)", winnerName });
      out.push({ type:"approval",email, maker, id: rid, date, notes:"from CSV(auto,maker-as-approval)", winnerName });
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

  const normalized = normalizeCsv(text);

  let nA=0, nS=0, nM=0, sum=0;
  const makerActorCount: Record<string, Record<string, number>> = {};

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
        actor: email? {name: displayName(email), email}: undefined,
        id, maker
      });
      // メーカー別承認カウント（ランキング用）
      const key = (email || (r.winnerName || "")).toLowerCase();
      const mk = (maker || "不明").trim();
      makerActorCount[mk] ||= {};
      makerActorCount[mk][key] = (makerActorCount[mk][key] || 0) + 1;

      const cred = getHabitica(email);
      if (!DRY_RUN && cred) await addApproval(cred, 1, "CSV");

      // 承認 通知（テンプレ統一）
      await safeCW(cwApprovalText(displayName(email, r.winnerName || "担当者"), maker || ""));
    }

    if (type==="sales") {
      nS++; sum+=(amount||0);
      appendJsonl("data/events/sales.jsonl",{
        at:new Date().toISOString(), day:isoDay(date), email,
        actor: email? {name: displayName(email), email}: undefined,
        id, maker, amount
      });
      const cred = getHabitica(email);
      if (!DRY_RUN && cred && amount) await addSales(cred, amount, "CSV");

      await safeCW(cwSalesText(displayName(email, r.winnerName || "担当者"), amount || 0, maker || ""));
    }

    if (type==="maker") {
      nM++;
      appendJsonl("data/events/maker.jsonl",{
        at:new Date().toISOString(), day:isoDay(date), email,
        actor: email? {name: displayName(email), email}: undefined,
        id, maker
      });
      // ここでは付与しない（ランキング後にまとめて付与）
    }
  }

  // ---- ⚙ メーカー賞 自動付与（当日承認ベース） ----
  function decideMakerAward(m: Record<string, Record<string, number>>) {
    let topMaker = ""; let topCount = -1;
    for (const mk of Object.keys(m)) {
      const sum = Object.values(m[mk]).reduce((a,b)=>a+b,0);
      if (sum > topCount) { topCount = sum; topMaker = mk; }
    }
    if (!topMaker) return { topMaker:"", winners:[] as string[] };
    const map = m[topMaker] || {};
    const best = Math.max(...Object.values(map));
    const winners = Object.keys(map).filter(k => map[k] === best);
    return { topMaker, winners };
  }
  const { topMaker, winners } = decideMakerAward(makerActorCount);
  if (topMaker && winners.length) {
    for (const w of winners) {
      const email = w.includes("@") ? w : NAME2MAIL[w] || undefined;
      const cred = getHabitica(email);
      if (cred && !DRY_RUN) {
        try { await addMakerAward(cred, 1); } catch {}
        try { await addBadge?.(cred, "⚙メーカー賞"); } catch {}
      } else {
        console.log(`[maker-award][DRY_RUN or no-cred] maker=${topMaker} winner=${w}`);
      }
      const disp = w.includes("@") ? displayName(email, w.split("@")[0]) : w;
      await safeCW(
        `皆さんお疲れ様です！\n⚙メーカー賞 発表✨\n本日の最多メーカーは「${topMaker}」！\n最多貢献の ${disp} さんに特別称号を付与しました👏`
      );
    }
  }

  // 取り込みサマリ
  await safeCW(`[info][title]CSV取込[/title]承認 ${nA} 件 / 売上 ${nS} 件(計¥${toLocaleYen(sum)}) / メーカー ${nM} 件[/info]`);

  res.json({
    ok:true,
    mode:"upsert",
    received: normalized.length,
    accepted:{approval:nA,sales:nS,maker:nM},
    totalSales: sum,
    makerAward: { topMaker, winners },
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
    const nm = (a:any)=> displayName(a?.email, a?.actor?.name);
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

// =============== マッピング診断 ===============
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
  if (!cred) {
    log(`[daily] +${DAILY_BONUS_XP}XP (no-cred) email=${email} task="${text}"`);
    appendJsonl("data/events/daily_bonus.jsonl", { at: new Date().toISOString(), day, email, task: text, dry_run: true });
    markDailyBonusGiven(email, day);
    return res.json({ ok: true });
  }

  try {
    const title = `🗓日報ボーナス（${displayName(email)}） +${DAILY_BONUS_XP}XP`;
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

// =============== Start ===============
app.listen(PORT, ()=>{
  log(`listening :${PORT} DRY_RUN=${DRY_RUN} unit=${CALL_XP_UNIT_MS}ms per5min=${CALL_XP_PER_5MIN} perCall=${CALL_XP_PER_CALL}`);
  log(`[habitica] users=${Object.keys(HAB_MAP).length}, [name->email] entries=${Object.keys(NAME2MAIL).length}`);
  log(`[env] APPOINTMENT_XP=${APPOINTMENT_XP} DAILY_BONUS_XP=${DAILY_BONUS_XP}`);
  log(`[env] APPOINTMENT_VALUES=${JSON.stringify(APPOINTMENT_VALUES)}`);
});
export {};
