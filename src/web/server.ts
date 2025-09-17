// server.ts
import express, { Request, Response } from "express";
import crypto from "crypto";
import Busboy from "busboy";
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
function appendJsonl(fp: string, obj: any) {
  ensureDir(path.dirname(fp)); fs.appendFileSync(fp, JSON.stringify(obj) + "\n");
}
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

// 通話XP（累計5分ごと）
const CALL_TOTALIZE_5MIN = String(process.env.CALL_TOTALIZE_5MIN || "1") === "1";
const CALL_XP_PER_CALL    = Number(process.env.CALL_XP_PER_CALL || 0);
const CALL_XP_PER_5MIN    = Number(process.env.CALL_XP_PER_5MIN || 2);
const CALL_XP_UNIT_MS     = Number(process.env.CALL_XP_UNIT_MS || 300000);
const CALL_CHATWORK_NOTIFY = String(process.env.CALL_CHATWORK_NOTIFY || "0") === "1";

// CSV UI 設定（簡略）
const CSV_UPLOAD_TOKENS = String(process.env.CSV_UPLOAD_TOKENS || "").split(",").map(s=>s.trim()).filter(Boolean);

// =============== 外部コネクタ ===============
import { sendChatworkMessage } from "../connectors/chatwork.js";
import { createTodo, completeTask, addApproval, addSales, addMakerAward } from "../connectors/habitica.js";

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
  res.json({ ok:true, version:"2025-09-17-totalize5m", tz:process.env.TZ||"Asia/Tokyo",
    now:new Date().toISOString(), baseUrl:PUBLIC_BASE_URL||null, dryRun:DRY_RUN,
    habiticaUserCount:Object.keys(HAB_MAP).length, nameMapCount:Object.keys(NAME2MAIL).length
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

  // 署名候補（RenderのX-ForwardedやPUBLIC_BASE_URL差を吸収）
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

  // HEXのみ variant (Zoom Phone 稀に)
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

  const raw = b?.payload?.object || b?.object || b || {};
  const email =
    raw.user_email || raw.owner_email || raw.caller_email || raw.callee_email || b.email;
  const zid = raw.zoom_user_id || raw.user_id || raw.owner_id;
  const whoRaw = { userEmail: email || (zid && ZOOM_UID2MAIL[String(zid)]) || undefined };

  // duration 推定
  const cand = [raw.duration_ms, raw.call_duration_ms, raw.durationMs, raw.duration, raw.call_duration, b.duration];
  let ms = cand.map(Number).find(x=>Number.isFinite(x)) || 0;
  if(ms>0 && ms<100000) ms*=1000;
  if(ms<=0 && raw.start_time && raw.end_time){
    const st = new Date(raw.start_time).getTime();
    const et = new Date(raw.end_time).getTime();
    if(Number.isFinite(st)&&Number.isFinite(et)) ms=Math.max(0, et-st);
  }
  const callId = raw.call_id || raw.session_id || raw.callID || raw.sessionID || b.id || `zoom:${Date.now()}`;

  log(`[zoom] accepted callId=${callId} ms=${ms}`);
  await handleCallDurationEvent({ source:"workflow", eventId:b.event_id||callId, callId, durationMs:inferDurationMs(ms), occurredAt:b.timestamp||raw.end_time||Date.now(), raw: whoRaw });
  res.json({ok:true, accepted:true, ms});
});

// =============== 正規化処理 & だれ特定 ===============
type Normalized = { source:"v3"|"workflow"; eventId?:any; callId?:any; outcome?:string; occurredAt?:any; raw?:any; };
function extractDxPortNameFromText(s?: string): string|undefined {
  if(!s) return; const m=String(s).match(/DX\s*PORT(?:の|:)?\s*([^\n\r、，。・;；【】\[\]\(\)]+?)(?:\s*(?:さん|様|殿|君))?(?:$|[。．、，\s])/i);
  return m?.[1] ? normSpace(m[1]).replace(/\s+/g," ").trim(): undefined;
}
function resolveActor(ev:{source:"v3"|"workflow"; raw?:any}):{name:string; email?:string}{
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

  const isAppt = String(ev.outcome||"").trim() && ["appointment_scheduled","新規アポ"].includes(String(ev.outcome).toLowerCase());
  if (isAppt) { await awardXpForAppointment(ev); await notifyChatworkAppointment(ev); }
  else { log(`non-appointment outcome=${ev.outcome||"(empty)"}`); }
}

// =============== Habitica付与（アポ） & Chatwork通知（読みやすく） ===============
async function awardXpForAppointment(ev: Normalized){
  const who = resolveActor({source:ev.source, raw:ev.raw});
  const cred = getHabitica(who.email);
  const when = fmtJST(ev.occurredAt);
  if (!cred || DRY_RUN) {
    log(`[XP] appointment scheduled (DRY_RUN or no-cred) callId=${ev.callId} by=${who.name} @${when}`);
    appendJsonl("data/events/appointments.jsonl",{at:new Date().toISOString(),day:isoDay(ev.occurredAt),callId:ev.callId,actor:who});
    return;
  }
  const todo = await createTodo(`🟩 新規アポ（${who.name}）`, `source=${ev.source}\ncallId=${ev.callId}\nwhen=${when}`, undefined, cred);
  const id = (todo as any)?.id; if (id) await completeTask(id, cred);
  appendJsonl("data/events/appointments.jsonl",{at:new Date().toISOString(),day:isoDay(ev.occurredAt),callId:ev.callId,actor:who});
}

// Chatwork（ユーザーファーストで簡潔に）
function cwApptMessage(ev: Normalized){
  const who = resolveActor({source:ev.source, raw:ev.raw});
  const when = fmtJST(ev.occurredAt);
  return [
    "[info]",
    `[title]🎉 新規アポ 獲得[/title]`,
    `・担当：**${who.name}**`,
    `・時刻：${when}`,
    `・ソース：${ev.source.toUpperCase()}`,
    "",
    "この勢いで次の1件、行きましょう！💪",
    "[/info]",
  ].join("\n");
}
function cwCallTotalizeMessage(name:string, addSteps:number, xp:number, day:string, totalMs:number){
  return [
    "[info]",
    "[title]📞 架電XP（累計）[/title]",
    `・担当：**${name}**`,
    `・付与：+${xp} XP（5分×${addSteps}）`,
    `・本日累計：${(totalMs/60000).toFixed(1)} 分`,
    `・日付：${day}`,
    "[/info]",
  ].join("\n");
}
async function notifyChatworkAppointment(ev: Normalized){
  try { await sendChatworkMessage(cwApptMessage(ev)); } catch {}
}

// =============== 通話（累計5分ごとXP） ===============
type CallDurEv = { source:"v3"|"workflow"; eventId?:any; callId?:any; durationMs:number; occurredAt?:any; raw?:any; };
function inferDurationMs(v:any){ const n=Number(v); if(!Number.isFinite(n)||n<=0) return 0; return n>=100000?Math.floor(n):Math.floor(n*1000); }

// 累計ステート（日×メール）
const CALL_STATE_FP = "data/state/call_totals.json";
type CallState = Record<string, Record<string, { total_ms:number; steps_awarded:number }>>;
function loadCallState(): CallState { return readJson(CALL_STATE_FP, {} as CallState); }
function saveCallState(s: CallState){ writeJson(CALL_STATE_FP, s); }

function computePerCallXp(ms:number){ const base=CALL_XP_PER_CALL; const extra = ms>0? Math.floor(ms/CALL_XP_UNIT_MS)*CALL_XP_PER_5MIN:0; return base+extra; }
function computeNewSteps(totalMs:number, prevSteps:number){ const nowSteps=Math.floor(totalMs/CALL_XP_UNIT_MS); const add=Math.max(0, nowSteps-(prevSteps||0)); return {nowSteps, add}; }

async function awardXpForCallDuration(ev: CallDurEv){
  const when = fmtJST(ev.occurredAt);
  const who = resolveActor({source:ev.source, raw:ev.raw});
  appendJsonl("data/events/calls.jsonl",{at:new Date().toISOString(), day:isoDay(ev.occurredAt), callId:ev.callId, ms:ev.durationMs, actor:who});

  // 累計方式で付与
  if (CALL_TOTALIZE_5MIN) {
    const day = isoDay(ev.occurredAt);
    const email = (who.email||"").toLowerCase();
    if (!email) { log("[call] totalize: no email"); return; }

    const st = loadCallState();
    st[day] ??= {}; st[day][email] ??= { total_ms:0, steps_awarded:0 };
    st[day][email].total_ms += Math.max(0, Math.floor(ev.durationMs));

    const { nowSteps, add } = computeNewSteps(st[day][email].total_ms, st[day][email].steps_awarded);
    if (add<=0) { saveCallState(st); return; }

    const xp = add * CALL_XP_PER_5MIN;
    st[day][email].steps_awarded = nowSteps; saveCallState(st);

    const cred = getHabitica(who.email);
    if (!cred || DRY_RUN) {
      log(`[call] (DRY_RUN or no-cred) totalize +${xp}XP (${add} steps) by=${who.name} @${when}`);
      return;
    }
    const title = `📞 累計架電（${who.name}） +${xp}XP`;
    const notes = `day=${day}\nemail=${email}\ntotal_ms=${st[day][email].total_ms}\nsteps_awarded=${st[day][email].steps_awarded}`;
    try { const todo = await createTodo(title, notes, undefined, cred); const id=(todo as any)?.id; if(id) await completeTask(id, cred); } catch(e:any){ console.error("[call-totalize] habitica failed:", e?.message||e); }
    if (CALL_CHATWORK_NOTIFY) { try{ await sendChatworkMessage(cwCallTotalizeMessage(who.name, add, xp, day, st[day][email].total_ms)); }catch{} }
    return;
  }

  // 旧：1コール内での計算（必要なら）
  const xp = computePerCallXp(ev.durationMs);
  if (xp<=0) return;
  const cred = getHabitica(who.email);
  if (!cred || DRY_RUN) { log(`[call] (DRY_RUN or no-cred) per-call xp=${xp} by=${who.name} @${when}`); return; }
  const title = `📞 架電（${who.name}） +${xp}XP`;
  const notes = `per-call: +${CALL_XP_PER_CALL} + ${CALL_XP_PER_5MIN}×floor(${ev.durationMs}/${CALL_XP_UNIT_MS})`;
  try { const todo = await createTodo(title, notes, undefined, cred); const id=(todo as any)?.id; if(id) await completeTask(id, cred); } catch(e:any){ console.error("[call] habitica failed:", e?.message||e); }
}

async function handleCallDurationEvent(ev: CallDurEv){
  const id = ev.eventId ?? ev.callId ?? `dur:${ev.durationMs}`;
  if (hasSeen(id)) return; markSeen(id);
  if (ev.durationMs<=0) return;
  await awardXpForCallDuration(ev);
}

// =============== CSV（簡略・既存互換） ===============
function requireBearerCsv(req: Request, res: Response): boolean {
  const token = (req.header("authorization")||"").replace(/^Bearer\s+/i,"");
  if (!AUTH_TOKEN && CSV_UPLOAD_TOKENS.length===0) { res.status(500).json({ok:false,error:"missing tokens"}); return false; }
  if (token===AUTH_TOKEN) return true;
  if (CSV_UPLOAD_TOKENS.includes(token)) return true;
  res.status(401).json({ok:false,error:"auth"}); return false;
}
app.post("/admin/csv", express.text({ type:"text/csv", limit:"10mb" }));
app.post("/admin/csv", async (req: Request, res: Response)=>{
  if(!requireBearerCsv(req,res)) return;
  const text = String((req as any).body||"");
  const recs:any[] = csvParse(text,{ columns:true, bom:true, skip_empty_lines:true, trim:true, relax_column_count:true });
  let nA=0, nS=0, nM=0, sum=0;
  for (const r of recs) {
    const type = String(r.type||"").trim();
    const email = r.email? String(r.email).toLowerCase(): undefined;
    const amount = r.amount!=null? Number(String(r.amount).replace(/[^\d.-]/g,"")): undefined;
    const maker = r.maker? String(r.maker).trim(): undefined;
    const id = String(r.id || `${type}:${email||"-"}:${maker||"-"}`).trim();
    const date = r.date? String(r.date): undefined;
    if (type==="approval") { nA++; appendJsonl("data/events/approvals.jsonl",{at:new Date().toISOString(),day:isoDay(date),email,actor:email?{name:email.split("@")[0],email}:undefined,id,maker}); const cred=getHabitica(email); if(!DRY_RUN&&cred) await addApproval(cred,1, "CSV"); }
    if (type==="sales")    { nS++; sum+=(amount||0); appendJsonl("data/events/sales.jsonl",{at:new Date().toISOString(),day:isoDay(date),email,actor:email?{name:email.split("@")[0],email}:undefined,id,maker,amount}); const cred=getHabitica(email); if(!DRY_RUN&&cred&&amount) await addSales(cred, amount, "CSV"); }
    if (type==="maker")    { nM++; appendJsonl("data/events/maker.jsonl",{at:new Date().toISOString(),day:isoDay(date),email,actor:email?{name:email.split("@")[0],email}:undefined,id,maker}); const cred=getHabitica(email); if(!DRY_RUN&&cred) await addMakerAward(cred,1); }
  }
  try{ await sendChatworkMessage(`[info][title]CSV取込[/title]承認 ${nA} / 売上 ${nS}(計¥${sum.toLocaleString()}) / メーカー ${nM}[/info]`);}catch{}
  res.json({ ok:true, mode:"upsert", received:recs.length, accepted:{approval:nA,sales:nS,maker:nM}, totalSales:sum, duplicates:0, errors:0 });
});
app.get("/admin/template.csv", (_req,res)=>{
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",'attachment; filename="template.csv"');
  res.send("type,email,amount,maker,id,date,notes\napproval,info@example.com,0,,A-001,2025-09-08,承認OK\nsales,info@example.com,150000,,S-001,2025-09-08,受注\nmaker,info@example.com,,ACME,M-ACME-1,2025-09-08,最多メーカー\n");
});
app.get("/admin/upload", (_req,res)=>{
  const html = `<!doctype html><meta charset="utf-8"/><title>CSV取込（手動）</title>
  <style>body{font-family:system-ui;max-width:860px;margin:2rem auto;padding:0 1rem}textarea{width:100%;min-height:160px}</style>
  <h1>CSV取込（手動）</h1>
  <div><label>Base URL</label> <input id="base" size="40" value="${PUBLIC_BASE_URL||""}"/>
       <label>AUTH_TOKEN</label> <input id="tok" size="40"/></div>
  <p><input type="file" id="file" accept=".csv,text/csv"/> <button id="upload">アップロード</button></p>
  <p><textarea id="csv" placeholder="type,email,amount,maker,id,date,notes&#10;approval,info@example.com,0,,A-001,2025-09-08,承認OK"></textarea></p>
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
      const fd=new FormData(); fd.append('file', file, file.name);
      const r=await fetch(base.replace(/\\/$/,'')+'/admin/csv',{method:'POST',headers:{'Authorization':'Bearer '+tok},body:fd});
      const t=await r.text(); try{ pr(JSON.parse(t)); }catch{ pr(t); }
    }
    qs('#send').onclick=()=>postCsvRaw(qs('#csv').value);
    qs('#upload').onclick=()=>{ const f=qs('#file').files[0]; if(!f) return pr('CSVファイルを選択'); const fr=new FileReader(); fr.onload=()=>postCsvRaw(String(fr.result||'')); fr.readAsText(f); };
  </script>`;
  res.type("html").send(html);
});

// =============== ダッシュボード（Zoom反映済） ===============
app.get("/admin/dashboard", (_req,res)=>{
  const today = isoDay(), yest = isoDay(new Date(Date.now()-86400000));
  const rd = (fp:string)=> readJsonlAll(fp);
  const calls = rd("data/events/calls.jsonl");        // Zoom/HubSpotからの通話（累計対象）
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
app.get("/admin/state/calls", (req,res)=>{
  if(!requireBearer(req,res)) return;
  res.json({ ok:true, state: loadCallState() });
});

// =============== Start ===============
app.listen(PORT, ()=>{
  log(`listening :${PORT} DRY_RUN=${DRY_RUN} totalize=${CALL_TOTALIZE_5MIN} unit=${CALL_XP_UNIT_MS}ms per5min=${CALL_XP_PER_5MIN}`);
  log(`[habitica] users=${Object.keys(HAB_MAP).length}, [name->email] entries=${Object.keys(NAME2MAIL).length}`);
});
export {};
