// server.ts  — 2025-09-29 final+monthly-cumulative + company-cumulative(all-hands) + CSV UPSERT
// approval-date based daily/monthly summary + daily Maker Award auto-grant
import express, { Request, Response } from "express";
import crypto from "crypto";
import Busboy from "busboy";
import { parse as csvParse } from "csv-parse/sync";
import fs from "fs";
import path from "path";

/* =============== 基本 =============== */
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

/* =============== Utils =============== */
function log(...a: any[]) { console.log("[web]", ...a); }
function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }
function appendJsonl(fp: string, obj: any) { ensureDir(path.dirname(fp)); fs.appendFileSync(fp, JSON.stringify(obj) + "\n"); }
function readJsonlAll(fp: string): any[] {
  try { return fs.readFileSync(fp, "utf8").trim().split("\n").filter(Boolean).map(s=>JSON.parse(s)); } catch { return []; }
}
function isoDay(d?: any) {
  const t = d instanceof Date ? d : (d ? new Date(d) : new Date());
  return t.toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).replace(/\//g,"-");
}
function isoMonth(d?: any) {
  const t = d instanceof Date ? d : (d ? new Date(d) : new Date());
  return t.toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit"}).replace(/\//g,"-");
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

/* --- JSTの年月日＆月末判定（新規：月次メーカー賞で使用） --- */
function jstYmd(d?: any){ 
  const t = d instanceof Date ? d : (d ? new Date(d) : new Date());
  const parts = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(t);
  const m: any = {};
  for (const p of parts) if (p.type==="year"||p.type==="month"||p.type==="day") m[p.type] = Number(p.value);
  return { y: m.year, mo: m.month, d: m.day };
}
function isMonthEndJST(d?: any){
  const { y, mo, d: day } = jstYmd(d);
  if (!y || !mo || !day) return false;
  const last = new Date(y, mo, 0).getDate(); // 月末日（ローカルTZでも日数は同じ）
  return day === last;
}

/* HubSpot v3 の sourceId から userId を抜く（例: "userId:81798571" -> "81798571"） */
function parseHubSpotSourceUserId(raw: any): string | undefined {
  const s = String(raw?.sourceId || raw?.source_id || "");
  const m = s.match(/userId:(\d+)/i);
  return m ? m[1] : undefined;
}

/* =============== 定数（安全弁） =============== */
const MAX_CALL_MS = 3 * 60 * 60 * 1000;

/* --- Zoom payload からメール/方向/長さ/ID を安全に抜く --- */
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
    if (Number.isFinite(st) && Number.isFinite(et)) {
      ms = Math.max(0, et - st);
    } else {
      ms = 0;
    }
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

/* =============== ENV =============== */
const PORT = Number(process.env.PORT || 10000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const DRY_RUN = String(process.env.DRY_RUN || "0") === "1";
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/+$/,"");

// HubSpot v3
const WEBHOOK_SECRET = process.env.HUBSPOT_WEBHOOK_SIGNING_SECRET || process.env.HUBSPOT_APP_SECRET || "";

// Zoom
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
const CALL_TOTALIZE_5MIN = false as const;
const CALL_XP_PER_CALL = (process.env.CALL_XP_PER_CALL === undefined || process.env.CALL_XP_PER_CALL === "")
  ? 1 : Number(process.env.CALL_XP_PER_CALL);
const CALL_XP_PER_5MIN   = Number(process.env.CALL_XP_PER_5MIN || 2);
const CALL_XP_UNIT_MS    = Number(process.env.CALL_XP_UNIT_MS || 300000);

// CSV UI 設定
const CSV_UPLOAD_TOKENS = String(process.env.CSV_UPLOAD_TOKENS || "").split(",").map(s=>s.trim()).filter(Boolean);

// 日報ボーナス
const DAILY_BONUS_XP = Number(process.env.DAILY_BONUS_XP || 10);
const DAILY_TASK_MATCH = String(process.env.DAILY_TASK_MATCH || "日報").split(",").map(s => s.trim()).filter(Boolean);
const HABITICA_WEBHOOK_SECRET = process.env.HABITICA_WEBHOOK_SECRET || AUTH_TOKEN || "";

// 新規アポ
const APPOINTMENT_XP = Number(process.env.APPOINTMENT_XP || 20);
const APPOINTMENT_BADGE_LABEL = process.env.APPOINTMENT_BADGE_LABEL || "🎯 新規アポ";
const APPOINTMENT_VALUES = String(process.env.APPOINTMENT_VALUES || "appointment_scheduled,新規アポ")
  .split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);

// Chatwork: CSV明細1件ごとの通知はオフ（サマリ1通のみ）
const CW_PER_ROW = false;

// CSV取込：DXPort名が無い行はスキップ（社外混入防止）
const REQUIRE_DXPORT_NAME = true;

/* ===== 売上XPルール（累積用でも共有） ===== */
const SALES_XP_STEP_YEN = Number(process.env.SALES_XP_STEP_YEN || 100000); // 10万円
const SALES_XP_PER_STEP = Number(process.env.SALES_XP_PER_STEP || 50);     // 50XP/10万円

/* ===== 会社合計の全員配布（ON/OFF） ===== */
const COMPANY_SALES_TO_ALL = String(process.env.COMPANY_SALES_TO_ALL || "0") === "1";

/* =============== 外部コネクタ =============== */
import {
  sendChatworkMessage,
  cwApptText,
  cwApprovalText,
  cwSalesText,
  cwMakerAchievementText
} from "../connectors/chatwork.js";
import {
  createTodo,
  completeTask,
  addApproval,
  addSales,
  addMakerAward,
  addAppointment,
} from "../connectors/habitica.js";

/* =============== Habitica 429対策（直列キュー） =============== */
const HABITICA_MIN_INTERVAL_MS = Number(process.env.HABITICA_MIN_INTERVAL_MS || 300);
function sleep(ms:number){ return new Promise(r=>setTimeout(r,ms)); }
let _habQ: Promise<any> = Promise.resolve();
function habEnqueue<T>(fn:()=>Promise<T>): Promise<T> {
  const next = async () => {
    await sleep(HABITICA_MIN_INTERVAL_MS);
    return fn();
  };
  _habQ = _habQ.then(next, next);
  return _habQ as Promise<T>;
}
async function habSafe<T>(fn:()=>Promise<T>): Promise<T|undefined> {
  try { return await habEnqueue(fn); }
  catch(e:any){ console.error("[habitica] suppressed:", e?.message||e); return undefined; }
}

/* =============== マップ構築 =============== */
type HabiticaCred = { userId: string; apiToken: string };
function buildHabiticaMap(s: string){ const p = safeParse<Record<string,HabiticaCred>>(s)||{}; const out:Record<string,HabiticaCred>={}; for(const [k,v] of Object.entries(p)){ if(v?.userId && v?.apiToken) out[k.toLowerCase()]={userId:String(v.userId),apiToken:String(v.apiToken)}; } return out; }
function buildNameEmailMap(s: string){ const p = safeParse<Record<string,string>>(s)||{}; const out:Record<string,string>={}; for(const [n,e] of Object.entries(p)){ if(!n||!e) continue; out[normSpace(n)] = e.toLowerCase(); } return out; }
function buildZoomEmailMap(s: string){ const p = safeParse<Record<string,string>>(s)||{}; const out:Record<string,string>={}; for(const [z,e] of Object.entries(p)){ if(!z||!e) continue; out[z]=e.toLowerCase(); } return out; }
const HAB_MAP = buildHabiticaMap(HABITICA_USERS_JSON);
const NAME2MAIL = buildNameEmailMap(NAME_EMAIL_MAP_JSON);
const ZOOM_UID2MAIL = buildZoomEmailMap(ZOOM_EMAIL_MAP_JSON);
const getHabitica = (email?: string)=> email? HAB_MAP[email.toLowerCase()]: undefined;

// 逆引き：email -> 日本語氏名
const MAIL2NAME: Record<string,string> = {};
for (const [jp, m] of Object.entries(NAME2MAIL)) { MAIL2NAME[m] = jp; }

/* --- 社内アポインター判定（メール or 氏名でホワイトリスト） --- */
const INTERNAL_EMAILS = new Set<string>(Object.keys(HAB_MAP));        // Habitica連携済みの社内メール
const INTERNAL_NAMES  = new Set<string>(Object.keys(NAME2MAIL).map(normSpace)); // 名前→メールのマップ値
function isInternal(name?: string, email?: string): boolean {
  const em = (email||"").toLowerCase().trim();
  const nm = normSpace(name);
  return (!!em && INTERNAL_EMAILS.has(em)) || (!!nm && INTERNAL_NAMES.has(nm));
}

/* =============== 重複抑止 =============== */
const seen = new Map<string, number>();
const DEDUPE_TTL_SEC = Number(process.env.DEDUPE_TTL_SEC || 24*60*60);
function hasSeen(id?: any){ if(id==null) return false; const key=String(id); const now=Date.now(); for(const [k,ts] of seen){ if(now-ts>DEDUPE_TTL_SEC*1000) seen.delete(k); } return seen.has(key); }
function markSeen(id?: any){ if(id==null) return; seen.set(String(id), Date.now()); }

/* =============== Health/Support =============== */
app.get("/healthz", (_req,res)=>{
  res.json({ ok:true, version:"2025-09-29-spec-v1.4", tz:process.env.TZ||"Asia/Tokyo",
    now:new Date().toISOString(), baseUrl:PUBLIC_BASE_URL||null, dryRun:DRY_RUN,
    habiticaUserCount:Object.keys(HAB_MAP).length, nameMapCount:Object.keys(NAME2MAIL).length,
    apptValues: APPOINTMENT_VALUES, totalize: CALL_TOTALIZE_5MIN
  });
});
app.get("/support", (_req,res)=>res.type("text/plain").send("Support page"));

/* =============== HubSpot v3 Webhook（署名検証） =============== */
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

/* =============== HubSpot Workflow（Bearerのみ） =============== */
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

/* =============== Zoom Webhook =============== */
function readBearerFromHeaders(req: Request){ for(const k of ["authorization","x-authorization","x-auth","x-zoom-authorization","zoom-authorization"]) { const v=req.get(k); if(!v) continue; const m=v.trim().match(/^Bearer\s+(.+)$/i); return (m?m[1]:v).trim(); } return ""; }
function verifyZoomSignature(req: Request & { rawBody?: Buffer }){
  const header = req.get("x-zm-signature") || "";
  if(!header) return { ok:false, why:"no_header" };
  const body = (req.rawBody ?? Buffer.from("", "utf8")).toString("utf8");

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

  const m = header.match(/^v0[:=](\d+):([A-Za-z0-9+/=]+)$/);
  if(!m) return { ok:false, why:"bad_format" };
  const ts = Number(m[1]); const sig = m[2];
  const now = Math.floor(Date.now()/1000); if(Math.abs(now-ts) > ZOOM_SIG_SKEW) return { ok:false, why:"timestamp_skew" };
  if(!ZOOM_WEBHOOK_SECRET) return { ok:false, why:"no_secret" };

  const macA = crypto.createHmac("sha256", ZOOM_WEBHOOK_SECRET).update(`${ts}${body}`).digest("base64");
  const macB = crypto.createHmac("sha256", ZOOM_WEBHOOK_SECRET).update(`v0:${ts}:${body}`).digest("base64");
  const eqB64 = (mac:string)=>{ try{ return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sig)); }catch{return false;} };
  return { ok: eqB64(macA)||eqB64(macB), variant:"v0_ts_b64" };
}

app.post("/webhooks/zoom", async (req: Request & { rawBody?: Buffer }, res: Response)=>{
  const rawText = req.rawBody? req.rawBody.toString("utf8"): undefined;
  let b:any = (req as any).body || {};
  if(!b || (Object.keys(b).length===0 && rawText)) { try{ b=JSON.parse(rawText!);}catch{} }

  const plain = b?.plainToken || b?.payload?.plainToken || b?.event?.plainToken;
  if(plain){
    const key = ZOOM_WEBHOOK_SECRET || AUTH_TOKEN || "dummy";
    const enc = crypto.createHmac("sha256", key).update(String(plain)).digest("hex");
    return res.json({ plainToken:String(plain), encryptedToken:enc });
  }

  let ok = false;
  if (req.get("x-zm-signature")) ok = verifyZoomSignature(req).ok;
  if (!ok) {
    const expected = ZOOM_BEARER_TOKEN || ZOOM_WEBHOOK_SECRET || AUTH_TOKEN || "";
    if (expected && readBearerFromHeaders(req) === expected) ok = true;
  }
  if(!ok) return res.status(401).json({ok:false,error:"auth"});

  const obj = b?.payload?.object || b?.object || {};
  const info = pickZoomInfo(obj);
  const resolvedEmail = info.email || (info.zid && ZOOM_UID2MAIL[String(info.zid)]) || undefined;

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

/* =============== 正規化処理 & だれ特定 =============== */
type Normalized = { source:"v3"|"workflow"; eventId?:any; callId?:any; outcome?:string; occurredAt?:any; raw?:any; };

// HubSpot担当者の解決：sourceId(userId) と hubspot_user_map を使う
function resolveActor(ev:{source:"v3"|"workflow"|"zoom"; raw?:any}):{name:string; email?:string}{
  const raw = ev.raw||{};

  // 1) email の明示（あれば最優先）
  let email: string|undefined =
    raw.actorEmail || raw.ownerEmail || raw.userEmail ||
    raw?.owner?.email || raw?.properties?.owner_email || raw?.properties?.hubspot_owner_email ||
    raw?.userEmail;

  // 2) HubSpotの user/owner のID候補を総当り + sourceId(userId:xxxx)
  const ownerId =
    raw?.properties?.hubspot_owner_id ??
    raw?.hubspot_owner_id ??
    parseHubSpotSourceUserId(raw) ??
    raw?.ownerId ?? raw?.associatedOwnerId ?? raw?.owner_id ?? raw?.hsUserId ?? raw?.createdById ?? raw?.actorId ?? raw?.userId;

  // 3) 環境変数のマップで補完
  const hsMap = safeParse<Record<string,{name?:string; email?:string}>>(HUBSPOT_USER_MAP_JSON) || {};
  const hs = ownerId != null ? hsMap[String(ownerId)] : undefined;

  // 4) 最終 email
  const finalEmail = (email || hs?.email || "").toLowerCase() || undefined;

  // 5) 表示名
  const display =
    (finalEmail && MAIL2NAME[finalEmail]) ||
    (hs?.name) ||
    (finalEmail ? String(finalEmail).split("@")[0] : undefined) ||
    "担当者";

  return { name: display, email: finalEmail };
}

/* ここから下のCSV担当者判定のみ変更（名乗り対応を追加。その他は不変） */
// CSVの1行から actor を決定（名乗り > DXPort > メール）
function resolveActorFromRow(r:any): {name?:string; email?:string} {
  // 最優先: 「名乗り」列（そのまま氏名として採用）
  const K_NANORI = [
    "名乗り","名乗り（DXPort）","名乗り（dxport）","名乗り（ＤＸＰｏｒｔ）"
  ];
  const kNanori = firstMatchKey(r, K_NANORI);
  if (kNanori) {
    const raw = String(r[kNanori] || "");
    // 万一「DXPortの〜」と書かれていても抽出、無ければそのまま
    const nameJp = extractDxPortNameFromText(raw) || normSpace(raw);
    if (nameJp) {
      const email = NAME2MAIL[nameJp];
      return { name: nameJp, email };
    }
  }

  // つぎ: DXPortの〜 などの自由記述から抽出
  const K_DX = [
    "承認条件 回答23","承認条件 回答２３","DXPortの","DX PORTの",
    "DXPortの担当者","獲得者","DX Portの","DXportの","dxportの","dx portの",
    "自由記述","備考（dxport）","dxport 備考"
  ];
  const C_EMAIL = [
    "email","mail",
    "担当者メール","担当者 メール","担当者 メールアドレス","担当メール","担当者email",
    "owner email","オーナー メール","ユーザー メール","営業担当メール","担当者e-mail","担当e-mail","担当者メールアドレス","担当者のメール"
  ];

  const kDx = firstMatchKey(r, K_DX);
  if (kDx) {
    const nameJp = extractDxPortNameFromText(String(r[kDx]||""));
    if (nameJp) {
      const email = NAME2MAIL[nameJp];
      return { name: nameJp, email };
    }
  }
  const kEmail  = firstMatchKey(r, C_EMAIL);
  if (kEmail) {
    const e = String(r[kEmail]||"").toLowerCase().trim();
    if (e) return { name: MAIL2NAME[e] || e.split("@")[0], email: e };
  }
  return {};
}

/* ===== 以降は変更なし ===== */

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
    the:
    {
      const k = lc(key);
      if (candidates.some(c => k.includes(lc(c)))) { return key; }
    }
  }
  return undefined;
}

// 承認日時のゆるいパース（YYYY/MM/DD[ HH:mm[:ss]] と - の両対応）
function parseApprovalAt(s?: string): Date | null {
  if (!s) return null;
  const t = String(s).trim().replace(/-/g, "/");
  const m = t.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (m) {
    const [_, y, mo, d, h = "0", mi = "0", se = "0"] = m;
    const dLocal = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
    return isNaN(dLocal.getTime()) ? null : dLocal;
  }
  const d2 = new Date(t);
  return isNaN(d2.getTime()) ? null : d2;
}

// DXPort の自由記述から氏名を抜く（唯一の定義）
function extractDxPortNameFromText(s?: string): string|undefined {
  const t = normSpace(s);
  if (!t) return undefined;
  // 例: "DX PORTの 山田太郎", "DxPortの田中", "DXPORTの: 佐藤", "DXportの東里奈"
  const m = t.match(/D\s*X\s*(?:P\s*O\s*R\s*T)?\s*の\s*([^\s].*)$/i);
  if (m && m[1]) return normSpace(m[1]);
  return undefined;
}

// CSV本文を Content-Type に依存せず取得（text/csv / multipart/form-data / raw）
async function readCsvTextFromReq(req: Request): Promise<string> {
  const ct = String(req.headers["content-type"] || "");

  if (ct.includes("multipart/form-data")) {
    return await new Promise<string>((resolve, reject) => {
      const bb = Busboy({ headers: req.headers as any });
      const chunks: Buffer[] = [];
      let gotFile = false;

      bb.on("file", (_name, file) => {
        gotFile = true;
        file.on("data", (d: Buffer) => chunks.push(Buffer.from(d)));
      });
      bb.on("field", (name: string, val: string) => {
        if (!gotFile && (name.toLowerCase() === "csv" || name.toLowerCase() === "text")) {
          chunks.push(Buffer.from(val, "utf8"));
        }
      });
      bb.once("error", reject);
      bb.once("finish", () => {
        const buf = Buffer.concat(chunks);
        let txt = buf.toString("utf8");
        if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
        resolve(txt);
      });
      (req as any).pipe(bb);
    });
  }

  const b: any = (req as any).body;
  if (typeof b === "string" && b.trim().length > 0) return b;

  return await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    (req as any)
      .on("data", (d: Buffer) => chunks.push(Buffer.from(d)))
      .on("end", () => {
        const buf = Buffer.concat(chunks);
        let txt = buf.toString("utf8");
        if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
        resolve(txt);
      })
      .on("error", () => resolve(""));
  });
}

/* ------------------------------------------------------------
   CSV 正規化（仕様どおりの厳格版）
   ・『名乗り』列の氏名、または「承認条件 回答23」等にある「DX PORTの◯◯」の◯◯が社内アポインター（INTERNAL_*）のみ採用
   ・「商談ステータス」が「承認」の行だけ採用
   ・「承認日時」をdayキーに使用（当日／当月の集計に反映）
   ・売上は金額があればsales、常にapprovalを1件カウント
------------------------------------------------------------ */
function normalizeCsv(text: string){
  const recs:any[] = csvParse(text,{ columns:true, bom:true, skip_empty_lines:true, trim:true, relax_column_count:true });

  // キー候補
  const C_MAKER   = ["メーカー","メーカー名","メーカー名（取引先）","ブランド","brand","maker","取引先名","会社名","メーカー（社名）"];
  const C_AMOUNT  = ["金額","売上","受注金額","受注金額（税込）","受注金額（税抜）","売上金額","売上金額（税込）","売上金額（税抜）","金額(円)","amount","price","契約金額","成約金額","合計金額","売上合計","報酬","追加報酬"];
  const C_ID      = ["id","ID","案件ID","取引ID","レコードID","社内ID","番号","伝票番号","管理番号"];
  const C_APPR_DT = ["承認日時","承認日"]; // day に使う
  const C_STATUS  = ["商談ステータス","ステータス","最終結果"]; // 必ず「承認」のみ通す

  type Out = {type:"approval"|"sales"|"maker"; email?:string; name?:string; amount?:number; maker?:string; id?:string; date?:Date; notes?:string};
  const out: Out[] = [];

  for (const r of recs) {
    // 1) 社内アポインター判定（名乗り or DX PORT名必須）
    const actor = resolveActorFromRow(r);
    if (REQUIRE_DXPORT_NAME && !actor.name) continue;
    if (!isInternal(actor.name, actor.email)) continue;

    // 2) ステータス=承認 のみ
    const kStatus = firstMatchKey(r, C_STATUS);
    if (kStatus) {
      const s = String(r[kStatus]||"").trim();
      const sLc = s.toLowerCase();
      const ok = ["承認","approved","approve","accepted","合格"].some(t => s.includes(t) || sLc===t);
      if (!ok) continue;
    }

    // 3) 承認日時（なければskip）
    const kApprDt = firstMatchKey(r, C_APPR_DT);
    const dateStr = kApprDt ? String(r[kApprDt]||"").trim() : "";
    const apprAt = parseApprovalAt(dateStr);
    if (!apprAt) continue; // 必須

    // 4) その他
    const kMaker  = firstMatchKey(r, C_MAKER);
    const kAmt    = firstMatchKey(r, C_AMOUNT);
    const kId     = firstMatchKey(r, C_ID);

    const maker = kMaker ? String(r[kMaker]||"").toString().trim() : undefined;

    let amount = kAmt ? numOrUndefined(r[kAmt]) : undefined;
    if (kAmt && /報酬/.test(kAmt)) {
      const addKey = firstMatchKey(r, ["追加報酬"]);
      if (addKey) {
        const add = numOrUndefined(r[addKey]);
        if (Number.isFinite(add as number)) amount = (amount || 0) + (add as number);
      }
    }

    const rid = kId ? String(r[kId]||"").toString().trim() : undefined;

    // 5) 必ず approval を1件計上
    out.push({ type:"approval", email:actor.email, name:actor.name, maker, id: rid, date: apprAt, notes:"from CSV(approved)" });

    // 6) 金額があるなら sales も計上
    if (amount && amount>0) {
      out.push({ type:"sales", email:actor.email, name:actor.name, amount, maker, id: rid, date: apprAt, notes:"from CSV(approved+amount)" });
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

/* ====== 月次累積：メーカー別 売上XP 付与（二重防止つき） ================== */
type SalesKey = { month: string; email: string; maker: string };
type SalesTouched = SalesKey & { }; // 将来拡張用

function keyOf(k: SalesKey){ return `${k.month}|${k.email}|${k.maker}`; }

function monthFromDay(day?: string){ return String(day||"").slice(0,7); }

/** レジャー：各 (month,email,maker) の「授与済みステップ数」を取得 */
function readSalesStepsLedger(): Map<string, number> {
  const pathLedger = "data/awards/sales_month_steps.jsonl";
  const rows = readJsonlAll(pathLedger);
  const m = new Map<string, number>();
  for (const r of rows) {
    const kk = keyOf({ month: String(r.month||""), email: String(r.email||"").toLowerCase(), maker: String(r.maker||"") });
    const steps = Number(r.steps||0);
    if (kk && Number.isFinite(steps)) m.set(kk, steps); // 最後の値を採用（append-only）
  }
  return m;
}

/** レジャー追記（append-only） */
function writeSalesStepsLedger(entry: { month:string; email:string; maker:string; steps:number; totalAmount:number; newSteps:number }) {
  appendJsonl("data/awards/sales_month_steps.jsonl", {
    at: new Date().toISOString(),
    month: entry.month,
    email: entry.email,
    maker: entry.maker,
    steps: entry.steps,           // 累積で何ステップ授与済みか
    newSteps: entry.newSteps,     // 今回追加分
    totalAmount: entry.totalAmount
  });
}

/** 当該 (month,email,maker) の累積売上合計（金額）を sales.jsonl から再集計 */
function sumMonthlySalesAmount(month: string, email: string, maker: string): number {
  const salesAll = readJsonlAll("data/events/sales.jsonl");
  let sum = 0;
  for (const s of salesAll) {
    const d = String(s.day||"");
    if (!d || d.slice(0,7)!==month) continue;
    const em = String(s?.actor?.email || s?.email || "").toLowerCase();
    const mk = String(s?.maker||"");
    if (em===email && mk===maker) sum += Number(s.amount||0);
  }
  return sum;
}

/** バッチ終了後にまとめて「累積で閾値を超えた分」だけXPを付与 */
async function awardMonthlyCumulativeFor(touched: SalesTouched[]){
  if (!touched.length) return;

  // 重複除去
  const uniqKeys = Array.from(new Set(touched.map(keyOf))).map(s=>{
    const [month,email,maker] = s.split("|");
    return { month, email, maker } as SalesKey;
  });

  const ledger = readSalesStepsLedger();

  for (const k of uniqKeys) {
    if (!k.email) continue; // email不明は付与不能
    const cred = getHabitica(k.email);
    if (!cred && !DRY_RUN) continue; // 実付与ができないならスキップ（DRY_RUNは通す）

    const totalAmt = sumMonthlySalesAmount(k.month, k.email, k.maker);
    if (totalAmt <= 0) continue;

    const stepsNow = Math.floor(totalAmt / SALES_XP_STEP_YEN);
    const prev = ledger.get(keyOf(k)) || 0;
    const delta = stepsNow - prev;
    if (delta <= 0) continue; // 追加なし

    // 追加分だけまとめてXP付与（addSalesは金額からXP計算するので stepYen*delta を渡す）
    const addAmount = SALES_XP_STEP_YEN * delta;

    if (!DRY_RUN && cred) {
      await habSafe(async ()=>{
        await addSales(cred, addAmount, `CSV monthly cumulative ${k.maker} ${k.month} (+${delta} step)`);
        return undefined as any;
      });
    } else {
      log(`[sales-cum] DRY_RUN or no-cred: email=${k.email} maker=${k.maker} month=${k.month} total=¥${totalAmt.toLocaleString()} stepsNow=${stepsNow} +${delta}`);
    }

    // レジャー更新（今回の授与後の累計ステップ数を記録）
    writeSalesStepsLedger({ month: k.month, email: k.email, maker: k.maker, steps: stepsNow, totalAmount: totalAmt, newSteps: delta });
  }
}

/* ====== 会社合計（当月） 到達ステップ → 全員配布（append-only ledger, 二重防止） ====== */
function readCompanyStepsLedger(): Map<string, number> {
  const rows = readJsonlAll("data/awards/company_sales_steps.jsonl");
  const m = new Map<string, number>();
  for (const r of rows) {
    const mo = String(r.month||"");
    const steps = Number(r.steps||0);
    if (mo && Number.isFinite(steps)) m.set(mo, steps); // 月→steps
  }
  return m;
}
function writeCompanyStepsLedger(entry: { month:string; steps:number; totalAmount:number; newSteps:number }) {
  appendJsonl("data/awards/company_sales_steps.jsonl", {
    at: new Date().toISOString(),
    month: entry.month,
    steps: entry.steps,
    newSteps: entry.newSteps,
    totalAmount: entry.totalAmount
  });
}
function sumCompanyMonthlySalesAmount(month: string): number {
  const salesAll = readJsonlAll("data/events/sales.jsonl");
  let sum = 0;
  for (const s of salesAll) {
    const d = String(s.day||"");
    if (!d || d.slice(0,7)!==month) continue;
    sum += Number(s.amount||0);
  }
  return sum;
}
/** このバッチで影響のある「月」のみ再集計し、Δstep>0 なら全員に配布 */
async function awardCompanyCumulativeForMonths(months: string[]) {
  if (!COMPANY_SALES_TO_ALL) return; // フラグOFF時は無効
  const uniq = Array.from(new Set(months.filter(Boolean)));
  if (!uniq.length) return;

  const ledger = readCompanyStepsLedger();

  for (const month of uniq) {
    const totalAmt = sumCompanyMonthlySalesAmount(month);
    if (totalAmt <= 0) continue;

    const stepsNow = Math.floor(totalAmt / SALES_XP_STEP_YEN);
    const prev = ledger.get(month) || 0;
    const delta = stepsNow - prev;
    if (delta <= 0) continue;

    const addAmount = SALES_XP_STEP_YEN * delta;
    const members = Object.entries(HAB_MAP); // [email, cred]
    let awarded = 0;

    if (!DRY_RUN) {
      for (const [_email, cred] of members) {
        if (!cred) continue;
        await habSafe(async ()=>{
          await addSales(cred, addAmount, `CSV company monthly cumulative ${month} (+${delta} step)`);
          return undefined as any;
        });
        awarded++;
      }
    } else {
      log(`[company-cum] DRY_RUN: month=${month} total=¥${totalAmt.toLocaleString()} stepsNow=${stepsNow} +${delta} toAll=${members.length}`);
      awarded = members.length;
    }

    // レジャー更新
    writeCompanyStepsLedger({ month, steps: stepsNow, totalAmount: totalAmt, newSteps: delta });

    // 任意通知（常時送信）
    try {
      const xpEach = SALES_XP_PER_STEP * delta;
      const msg = `🏢 会社合計売上（${month}）が +${delta}ステップ到達（累計 ¥${totalAmt.toLocaleString()}）。\n` +
                  `👥 社員全員（${members.length}名）に +${xpEach}XP を付与しました。`;
      await sendChatworkMessage(msg);
    } catch (e:any) {
      console.error("[company-cum] chatwork failed:", e?.message||e);
    }
  }
}

/* ================= CSV UPSERT のための永続キー ================ */
// 保存場所
const FP_IDX_APPR = "data/index/csv_approval_keys.jsonl";
const FP_IDX_SALES = "data/index/csv_sales_keys.jsonl";

function readKeySet(fp: string): Set<string> {
  const rows = readJsonlAll(fp);
  const s = new Set<string>();
  for (const r of rows) {
    const k = String(r.k ?? r.key ?? "");
    if (k) s.add(k);
  }
  return s;
}
function appendKey(fp: string, k: string) {
  appendJsonl(fp, { k, at: new Date().toISOString() });
}
function timeKey(d?: Date){ return d ? new Date(d).toISOString() : ""; } // UTC ISO固定で安定
function personKey(email?: string, name?: string){ return (email && email.trim()) ? `e:${email.toLowerCase()}` : `n:${normSpace(name||"")}`; }
function keyApproval(args:{date?:Date; maker?:string; email?:string; name?:string}) {
  return `a|${timeKey(args.date)}|${String(args.maker||"").trim()}|${personKey(args.email,args.name)}`;
}
function keySales(args:{date?:Date; maker?:string; email?:string; name?:string; amount?:number}) {
  const amt = Number(args.amount||0);
  return `s|${timeKey(args.date)}|${String(args.maker||"").trim()}|${personKey(args.email,args.name)}|${amt}`;
}

/* ===================== 診断API ===================== */
app.post("/admin/csv/detect", express.text({ type:"text/csv", limit:"20mb" }), (req, res) => {
  const text = String((req as any).body||"");
  const rows:any[] = csvParse(text,{ columns:true, bom:true, skip_empty_lines:true, trim:true, relax_column_count:true });
  const heads = rows.length ? Object.keys(rows[0]) : [];
  res.json({ ok:true, rows: rows.length, headers: heads, sample: rows.slice(0,3) });
});

// text/csv は既存通り受け付け
app.post("/admin/csv", express.text({ type:"text/csv", limit:"20mb" }));
// どの Content-Type でも CSV を受け取り可能に
app.post("/admin/csv", async (req: Request, res: Response)=>{
  if(!requireBearerCsv(req,res)) return;

  const text = await readCsvTextFromReq(req);
  if (!text || !text.trim()) {
    return res.json({ ok:true, mode: "noop", received: 0, accepted: { approval: 0, sales: 0, maker: 0 }, totalSales: 0, duplicates: 0, errors: 0, hint: "empty-or-unparsed-csv" });
  }

  const normalized = normalizeCsv(text);

  let nA=0, nS=0, nM=0, sum=0, dup=0;

  // このバッチで触れた (month,email,maker) を収集 → 累積付与に使用
  const touched: SalesTouched[] = [];
  // このバッチで触れた「月」（会社合計の再集計対象）
  const touchedMonths = new Set<string>();

  // UPSERTインデックス（永続）を事前読込
  const seenAppr = readKeySet(FP_IDX_APPR);
  const seenSales = readKeySet(FP_IDX_SALES);

  // 保存 & Habitica & （必要なら）行ごとのChatworkは従来どおり
  for (const r of normalized) {
    const actorName = r.name || (r.email ? (MAIL2NAME[r.email] || r.email.split("@")[0]) : "担当者");
    const email = r.email ? String(r.email).toLowerCase() : undefined;
    const amount = r.amount != null ? Number(r.amount) : undefined;
    const maker = r.maker ? String(r.maker).trim() : undefined;
    const id = String(r.id || `${r.type}:${actorName}:${maker||"-"}`).trim();
    const date = r.date;

    if (r.type==="approval") {
      const k = keyApproval({date, maker, email, name:actorName});
      if (seenAppr.has(k)) { dup++; continue; }
      seenAppr.add(k); appendKey(FP_IDX_APPR, k);

      nA++;
      appendJsonl("data/events/approvals.jsonl",{ at:new Date().toISOString(), day:isoDay(date), email, actor:{name:actorName, email}, id, maker });
      if (!DRY_RUN) {
        const cred = getHabitica(email);
        if (cred) await habSafe(()=>addApproval(cred,1,"CSV").then(()=>undefined as any));
      }
      if (CW_PER_ROW) { try { await sendChatworkMessage(cwApprovalText(actorName, maker)); } catch {} }
    }

    if (r.type==="sales") {
      const k = keySales({date, maker, email, name:actorName, amount});
      if (seenSales.has(k)) { dup++; continue; }
      seenSales.add(k); appendKey(FP_IDX_SALES, k);

      nS++; sum+=(amount||0);
      const day = isoDay(date);
      appendJsonl("data/events/sales.jsonl",{ at:new Date().toISOString(), day, email, actor:{name:actorName, email}, id, maker, amount });

      // 累積用のキーを記録（emailが無いと付与できないため、その場合はスキップ）
      if (email && maker) touched.push({ month: monthFromDay(day), email, maker });

      // 会社合計の当月キーを記録
      touchedMonths.add(monthFromDay(day));

      // ── 二重付与ガード ──
      // 単票が閾値未満のときのみ「行ベース即時付与」（従来動作と互換。>=閾値は累積側で一括付与）
      if (!DRY_RUN) {
        const cred = getHabitica(email);
        if (cred && amount && amount > 0 && amount < SALES_XP_STEP_YEN) {
          await habSafe(()=>addSales(cred, amount, "CSV (per-row < step)").then(()=>undefined as any));
        }
      }
      if (CW_PER_ROW) { try { await sendChatworkMessage(cwSalesText(actorName, amount, maker)); } catch {} }
    }

    if (r.type==="maker") {
      nM++;
      appendJsonl("data/events/maker.jsonl",{ at:new Date().toISOString(), day:isoDay(date), email, actor:{name:actorName, email}, id, maker });
      if (!DRY_RUN) {
        const cred = getHabitica(email);
        if (cred) await habSafe(()=>addMakerAward(cred,1).then(()=>undefined as any));
      }
      if (CW_PER_ROW) { try { await sendChatworkMessage(cwMakerAchievementText(actorName, maker)); } catch {} }
    }
  }

  // ===== 追加機能：メーカー別×担当者×月の「累積」XP付与 =====
  try {
    await awardMonthlyCumulativeFor(touched);
  } catch(e:any) {
    console.error("[sales-cumulative] failed:", e?.message||e);
  }

  // ===== 新機能：会社合計（当月）のΔステップ分を “全員” に配布 =====
  try {
    await awardCompanyCumulativeForMonths(Array.from(touchedMonths));
  } catch(e:any) {
    console.error("[company-cumulative] failed:", e?.message||e);
  }

  // ===== メーカー賞（本日分）自動付与（既存動作） =====
  try {
    const today = isoDay();
    const apprsToday = readJsonlAll("data/events/approvals.jsonl").filter(x => String(x.day||"") === today);

    // actorKey（email優先、なければ表示名）ごとのメーカー件数
    type Entry = { name:string; email?:string; makerCounts: Record<string, number> };
    const byActor: Record<string, Entry> = {};
    const actorKey = (a:any) => (String(a?.actor?.email || a?.email || "") || displayName(a)).toLowerCase();

    for (const a of apprsToday) {
      const key = actorKey(a);
      const email = String(a?.actor?.email || a?.email || "").toLowerCase() || undefined;
      const name = displayName(a);
      const maker = String(a?.maker || "").trim();
      if (!maker) continue;
      if (!byActor[key]) byActor[key] = { name, email, makerCounts:{} };
      byActor[key].makerCounts[maker] = (byActor[key].makerCounts[maker] || 0) + 1;
    }

    let best = 0;
    const winners: Entry[] = [];
    for (const e of Object.values(byActor)) {
      const top = Math.max(0, ...Object.values(e.makerCounts));
      if (top > 0) {
        if (top > best) { best = top; winners.length = 0; winners.push(e); }
        else if (top === best) { winners.push(e); }
      }
    }

    if (best > 0 && winners.length > 0) {
      const awardedLog = readJsonlAll("data/events/maker_awards.jsonl");
      const already = new Set(
        awardedLog.filter((x:any)=> String(x.day||"")===today)
                  .map((x:any)=> String(x.email || x?.actor?.email || "").toLowerCase())
      );

      for (const w of winners) {
        const em = (w.email||"").toLowerCase();
        if (!em) continue;               // Habitica付与にはemail必須
        if (already.has(em)) continue;   // 当日分の重複授与を抑止
        const cred = getHabitica(em);
        if (!DRY_RUN && cred) {
          await habSafe(()=>addMakerAward(cred,1).then(()=>undefined as any));
        }
        appendJsonl("data/events/maker_awards.jsonl", {
          at: new Date().toISOString(),
          day: today,
          email: em,
          actor: { name: w.name, email: em },
          topCount: best
        });
      }
    }
  } catch(e:any) {
    console.error("[maker-award] failed:", e?.message||e);
  }

  /* ===== メーカー賞（当月分）月末自動付与（新規追加） ===== */
  try {
    if (isMonthEndJST()) {
      const monthKey = isoMonth();
      type Entry = { name:string; email?:string; makerCounts: Record<string, number> };
      const byActor: Record<string, Entry> = {};

      // 月内の承認を集計
      const apprsAll = readJsonlAll("data/events/approvals.jsonl");
      const apprsMonth = apprsAll.filter(x => String(x.day||"").slice(0,7) === monthKey);

      const actorKey = (a:any) => (String(a?.actor?.email || a?.email || "") || displayName(a)).toLowerCase();
      for (const a of apprsMonth) {
        const key = actorKey(a);
        const email = String(a?.actor?.email || a?.email || "").toLowerCase() || undefined;
        const name = displayName(a);
        const maker = String(a?.maker || "").trim();
        if (!maker) continue;
        if (!byActor[key]) byActor[key] = { name, email, makerCounts:{} };
        byActor[key].makerCounts[maker] = (byActor[key].makerCounts[maker] || 0) + 1;
      }

      let best = 0;
      const winners: Entry[] = [];
      for (const e of Object.values(byActor)) {
        const top = Math.max(0, ...Object.values(e.makerCounts));
        if (top > 0) {
          if (top > best) { best = top; winners.length = 0; winners.push(e); }
          else if (top === best) { winners.push(e); }
        }
      }

      if (best > 0 && winners.length > 0) {
        // 月次の二重授与防止（この月ですでに受賞登録のある email を除外）
        const monthlyLog = readJsonlAll("data/events/maker_awards_monthly.jsonl");
        const already = new Set(
          monthlyLog.filter((x:any)=> String(x.month||"")===monthKey)
                    .map((x:any)=> String(x.email || x?.actor?.email || "").toLowerCase())
        );

        for (const w of winners) {
          const em = (w.email||"").toLowerCase();
          if (!em) continue;             // Habitica付与にはemail必須
          if (already.has(em)) continue; // その月は既に授与済み
          const cred = getHabitica(em);
          if (!DRY_RUN && cred) {
            await habSafe(()=>addMakerAward(cred,1).then(()=>undefined as any));
          }
          appendJsonl("data/events/maker_awards_monthly.jsonl", {
            at: new Date().toISOString(),
            month: monthKey,
            email: em,
            actor: { name: w.name, email: em },
            topCount: best
          });
        }
      }
    }
  } catch(e:any) {
    console.error("[maker-award-monthly] failed:", e?.message||e);
  }

  // ===== Chatwork: サマリ 1通だけ（承認日時ベースの 本日/当月 を “保存済みイベント” から集計） =====
  try {
    const today = isoDay();
    const monthKey = isoMonth();

    const apprsAll = readJsonlAll("data/events/approvals.jsonl");
    const salesAll = readJsonlAll("data/events/sales.jsonl");

    const apprsToday = apprsAll.filter(x => String(x.day||"") === today);
    const salesToday = salesAll.filter(x => String(x.day||"") === today);

    const apprsMonth = apprsAll.filter(x => String(x.day||"").slice(0,7) === monthKey);
    const salesMonth = salesAll.filter(x => String(x.day||"").slice(0,7) === monthKey);

    const sumAmt = (arr:any[]) => arr.reduce((a,b)=> a + Number(b.amount||0), 0);

    const nameOf = (a:any) => {
      const em = a?.actor?.email || a?.email;
      return (em && MAIL2NAME[em]) || a?.actor?.name || (em?.split?.("@")[0]) || "担当者";
    };

    function aggPeople(apprs:any[], sales:any[]){
      const map: Record<string,{name:string; apprs:number; salesSum:number; salesCount:number; makers:Record<string,number>}> = {};
      for(const a of apprs){
        const k = nameOf(a);
        map[k] ??= { name:k, apprs:0, salesSum:0, salesCount:0, makers:{} };
        map[k].apprs += 1;
      }
      for(const s of sales){
        const k = nameOf(s);
        map[k] ??= { name:k, apprs:0, salesSum:0, salesCount:0, makers:{} };
        const amt = Number(s.amount||0);
        map[k].salesSum += amt;
        map[k].salesCount += 1;
        const m = (s.maker||"").trim();
        if (m) map[k].makers[m] = (map[k].makers[m]||0) + amt;
      }
      return Object.values(map).sort((a,b)=> b.salesSum - a.salesSum || b.apprs - a.apprs || a.name.localeCompare(b.name));
    }

    function topLines(peeps: ReturnType<typeof aggPeople>){
      const rows = peeps.slice(0,20).map(p=>{
        const makers = Object.entries(p.makers).map(([m,amt])=>`${m}: ¥${Number(amt).toLocaleString()}`).join(", ");
        return `・${p.name}: 承認${p.apprs}件 / ¥${p.salesSum.toLocaleString()}（${p.salesCount}件）${makers?` / ${makers}`:""}`;
      });
      return rows.length? rows.join("\n") : "（該当なし）";
    }

    const lines:string[] = [];
    lines.push(`📦 CSV取込サマリー（承認日時ベース）`);
    lines.push(`📅 本日 ${today}`);
    lines.push(`  承認: ${apprsToday.length}件　💴 売上: ¥${sumAmt(salesToday).toLocaleString()}（${salesToday.length}件）`);
    lines.push(`  🧑 売上/承認（人別 Top）`);
    lines.push(topLines(aggPeople(apprsToday, salesToday)));
    lines.push(``);
    lines.push(`🗓 月次 ${monthKey}`);
    lines.push(`  承認: ${apprsMonth.length}件　💴 売上: ¥${sumAmt(salesMonth).toLocaleString()}（${salesMonth.length}件）`);
    lines.push(`  🧑 売上/承認（人別 Top）`);
    lines.push(topLines(aggPeople(apprsMonth, salesMonth)));

    await sendChatworkMessage(lines.join("\n"));
  } catch(e:any) {
    console.error("[csv summary] chatwork failed:", e?.message||e);
  }

  res.json({ ok:true, mode:"upsert", received: normalized.length, accepted:{approval:nA,sales:nS,maker:nM}, totalSales: sum, duplicates: dup, errors: 0 });
});

/* =============== ダッシュボード（本日 / 月次 / 前日） =============== */
function displayName(a:any){
  const em = a?.actor?.email || a?.email;
  if (em && MAIL2NAME[em]) return MAIL2NAME[em];
  return a?.actor?.name || (em?.split?.("@")[0]) || "担当者";
}

app.get("/admin/dashboard", (_req,res)=>{
  const today = isoDay(), yest = isoDay(new Date(Date.now()-86400000));
  const monthKey = isoMonth();
  const rd = (fp:string)=> readJsonlAll(fp);
  const calls = rd("data/events/calls.jsonl");
  const appts = rd("data/events/appointments.jsonl");
  const apprs = rd("data/events/approvals.jsonl");
  const sales = rd("data/events/sales.jsonl");

  function isMonth(d:string){ return String(d||"").slice(0,7) === monthKey; }

  function aggByDay(day:string){
    const by:Record<string, any> = {};
    const nm = (a:any)=> displayName(a);
    for(const x of calls.filter(v=>v.day===day)){ const k=nm(x); by[k]??={name:k,calls:0,min:0,appts:0,apprs:0,sales:0}; by[k].calls+=1; by[k].min+=Math.round((x.ms||0)/60000); }
    for(const x of appts.filter(v=>v.day===day)){ const k=nm(x); by[k]??={name:k,calls:0,min:0,appts:0,apprs:0,sales:0}; by[k].appts+=1; }
    for(const x of apprs.filter(v=>v.day===day)){ const k=nm(x); by[k]??={name:k,calls:0,min:0,appts:0,apprs:0,sales:0}; by[k].apprs+=1; }
    for(const x of sales.filter(v=>v.day===day)){ const k=nm(x); by[k]??={name:k,calls:0,min:0,appts:0,apprs:0,sales:0}; by[k].sales+=Number(x.amount||0); }
    for(const k of Object.keys(by)){ const v=by[k]; v.rate = v.appts>0? Math.round((v.apprs/v.appts)*100):0; }
    return Object.values(by).sort((a:any,b:any)=>a.name.localeCompare(b.name));
  }

  function aggByMonth(){
    const by:Record<string, any> = {};
    const nm = (a:any)=> displayName(a);
    for(const x of calls.filter(v=>isMonth(v.day))){ const k=nm(x); by[k]??={name:k,calls:0,min:0,appts:0,apprs:0,sales:0}; by[k].calls+=1; by[k].min+=Math.round((x.ms||0)/60000); }
    for(const x of appts.filter(v=>isMonth(v.day))){ const k=nm(x); by[k]??={name:k,calls:0,min:0,appts:0,apprs:0,sales:0}; by[k].appts+=1; }
    for(const x of apprs.filter(v=>isMonth(v.day))){ const k=nm(x); by[k]??={name:k,calls:0,min:0,appts:0,apprs:0,sales:0}; by[k].apprs+=1; }
    for(const x of sales.filter(v=>isMonth(v.day))){ const k=nm(x); by[k]??={name:k,calls:0,min:0,appts:0,apprs:0,sales:0}; by[k].sales+=Number(x.amount||0); }
    for(const k of Object.keys(by)){ const v=by[k]; v.rate = v.appts>0? Math.round((v.apprs/v.appts)*100):0; }
    return Object.values(by).sort((a:any,b:any)=>a.name.localeCompare(b.name));
  }

  function aggMakersByDay(day:string){
    const by:Record<string,{maker:string;count:number;sales:number}> = {};
    for(const x of apprs.filter(v=>v.day===day)){ const m=(x.maker||"").trim(); if(!m) continue; by[m]??={maker:m,count:0,sales:0}; by[m].count+=1; }
    for(const x of sales.filter(v=>v.day===day)){ const m=(x.maker||"").trim(); if(!m) continue; by[m]??={maker:m,count:0,sales:0}; by[m].sales+=Number(x.amount||0); }
    return Object.values(by).sort((a,b)=> b.count-a.count || b.sales-a.sales || a.maker.localeCompare(b.maker));
  }

  function aggMakersByMonth(){
    const by:Record<string,{maker:string;count:number;sales:number}> = {};
    for(const x of apprs.filter(v=>isMonth(v.day))){ const m=(x.maker||"").trim(); if(!m) continue; by[m]??={maker:m,count:0,sales:0}; by[m].count+=1; }
    for(const x of sales.filter(v=>isMonth(v.day))){ const m=(x.maker||"").trim(); if(!m) continue; by[m]??={maker:m,count:0,sales:0}; by[m].sales+=Number(x.amount||0); }
    return Object.values(by).sort((a,b)=> b.count-a.count || b.sales-a.sales || a.maker.localeCompare(b.maker));
  }

  const T=aggByDay(today), Y=aggByDay(yest), TM=aggMakersByDay(today), YM=aggMakersByDay(yest);
  const M=aggByMonth(), MM=aggMakersByMonth();

  const Row = (r:any)=>`<tr><td>${r.name}</td><td style="text-align:right">${r.calls}</td><td style="text-align:right">${r.min}</td><td style="text-align:right">${r.appts}</td><td style="text-align:right">${r.apprs}</td><td style="text-align:right">${r.rate}%</td><td style="text-align:right">¥${(r.sales||0).toLocaleString()}</td></tr>`;
  const RowM= (r:any)=>`<tr><td>${r.maker}</td><td style="text-align:right">${r.count}</td><td style="text-align:right">¥${(r.sales||0).toLocaleString()}</td></tr>`;
  const html = `<!doctype html><meta charset="utf-8"><title>ダッシュボード</title>
  <style>body{font-family:system-ui;margin:2rem}table{border-collapse:collapse;min-width:760px}th,td{border:1px solid #ddd;padding:.45rem .55rem}th{background:#f7f7f7}h2{margin-top:2rem}</style>
  <h1>ダッシュボード</h1>
  <h2>本日 ${today}</h2>
  <table><thead><tr><th>担当</th><th>コール</th><th>分</th><th>アポ</th><th>承認</th><th>承認率</th><th>売上</th></tr></thead><tbody>${T.map(Row).join("")||'<tr><td colspan="7">データなし</td></tr>'}</tbody></table>
  <h2>メーカー別（承認ベース） 本日 ${today}</h2>
  <table><thead><tr><th>メーカー</th><th>承認数</th><th>売上(合計)</th></tr></thead><tbody>${TM.map(RowM).join("")||'<tr><td colspan="3">データなし</td></tr>'}</tbody></table>
  <h2>月次（当月 ${monthKey}）</h2>
  <table><thead><tr><th>担当</th><th>コール</th><th>分</th><th>アポ</th><th>承認</th><th>承認率</th><th>売上</th></tr></thead><tbody>${M.map(Row).join("")||'<tr><td colspan="7">データなし</td></tr>'}</tbody></table>
  <h2>メーカー別（承認ベース） 月次 ${monthKey}</h2>
  <table><thead><tr><th>メーカー</th><th>承認数</th><th>売上(合計)</th></tr></thead><tbody>${MM.map(RowM).join("")||'<tr><td colspan="3">データなし</td></tr>'}</tbody></table>
  <h2>前日 ${yest}</h2>
  <table><thead><tr><th>担当</th><th>コール</th><th>分</th><th>アポ</th><th>承認</th><th>承認率</th><th>売上</th></tr></thead><tbody>${Y.map(Row).join("")||'<tr><td colspan="7">データなし</td></tr>'}</tbody></table>
  <h2>メーカー別（承認ベース） 前日 ${yest}</h2>
  <table><thead><tr><th>メーカー</th><th>承認数</th><th>売上(合計)</th></tr></thead><tbody>${YM.map(RowM).join("")||'<tr><td colspan="3">データなし</td></tr>'}</tbody></table>`;
  res.type("html").send(html);
});

app.get("/admin/mapping", (req,res)=>{
  if(!requireBearer(req,res)) return;
  res.json({ ok:true, habiticaEmails:Object.keys(HAB_MAP).sort(), nameEmailEntries:Object.keys(NAME2MAIL).length, zoomUserIdMapCount:Object.keys(ZOOM_UID2MAIL).length });
});

/* ===== 日報 Webhook（Habitica完了→+10XP） ===== */
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
  const token = String(req.query.t || req.query.token || "").trim();
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
    await habSafe(async ()=>{
      const title = `🗓日報ボーナス（${MAIL2NAME[email] || email.split("@")[0]}） +${DAILY_BONUS_XP}XP`;
      const notes = `rule=daily+${DAILY_BONUS_XP}\nsource=habitica_webhook\ntask="${text}"`;
      const todo = await createTodo(title, notes, undefined, cred);
      const id = (todo as any)?.id; if (id) await completeTask(id, cred);
      return undefined as any;
    });
    appendJsonl("data/events/daily_bonus.jsonl", { at: new Date().toISOString(), day, email, task: text });
    log(`[daily] +${DAILY_BONUS_XP}XP by=${email} task="${text}"`);
    markDailyBonusGiven(email, day);
    res.json({ ok: true, awarded: DAILY_BONUS_XP });
  } catch (e: any) {
    console.error("[daily] habitica award failed:", e?.message || e);
    res.status(500).json({ ok: false });
  }
});

/* =============== 通話（+1XP ＆ 5分ごとXP） =============== */
type CallDurEv = { source:"v3"|"workflow"|"zoom"; eventId?:any; callId?:any; durationMs:number; occurredAt?:any; raw?:any; };

function inferDurationMs(v:any){
  const n = Number(v);
  if(!Number.isFinite(n) || n<=0) return 0;
  if (n <= MAX_CALL_MS && n % 1000 === 0) return Math.min(n, MAX_CALL_MS);
  if (n <= 10800) return Math.min(n * 1000, MAX_CALL_MS);
  return Math.min(n, MAX_CALL_MS);
}

function computePerCallExtra(ms:number){ return ms>0? Math.floor(ms/CALL_XP_UNIT_MS)*CALL_XP_PER_5MIN:0; }

async function awardXpForCallDuration(ev: CallDurEv){
  if (ev.source !== "zoom") {
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

  if (CALL_XP_PER_CALL > 0) {
    const cred = getHabitica(who.email);
    if (!cred || DRY_RUN) {
      log(`[call] per-call base +${CALL_XP_PER_CALL}XP (DRY_RUN or no-cred) by=${who.name} @${when}`);
      console.log(`(+call) +${CALL_XP_PER_CALL}XP`);
    } else {
      await habSafe(async ()=>{
        const title = `📞 架電（${who.name}） +${CALL_XP_PER_CALL}XP`;
        const notes = `rule=per-call+${CALL_XP_PER_CALL}`;
        const todo = await createTodo(title, notes, undefined, cred);
        const id = (todo as any)?.id; if (id) await completeTask(id, cred);
        return undefined as any;
      });
    }
  }

  if (durMs >= MAX_CALL_MS) {
    console.log("[call] guard: durMs hit MAX_CALL_MS; suppress 5min extra, keep +1XP only");
    return;
  }

  const xpExtra = computePerCallExtra(durMs);
  if (xpExtra<=0) return;
  const cred = getHabitica(who.email);
  if (!cred || DRY_RUN) {
    log(`[call] per-call extra (5min) xp=${xpExtra} (DRY_RUN or no-cred) by=${who.name} @${when}`);
    console.log(`(5分加点) +${xpExtra}XP`);
    return;
  }
  await habSafe(async ()=>{
    const title = `📞 架電（${who.name}） +${xpExtra}XP（5分加点）`;
    const notes = `extra: ${CALL_XP_PER_5MIN}×floor(${durMs}/${CALL_XP_UNIT_MS})`;
    const todo = await createTodo(title, notes, undefined, cred);
    const id=(todo as any)?.id; if(id) await completeTask(id, cred);
    return undefined as any;
  });
}

async function handleCallDurationEvent(ev: CallDurEv){
  const id = ev.eventId ?? ev.callId ?? `dur:${ev.durationMs}`;
  if (hasSeen(id)) return; markSeen(id);
  await awardXpForCallDuration(ev);
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

/* =============== Habitica付与（アポ） & Chatwork通知 =============== */
async function awardXpForAppointment(ev: Normalized){
  const who = resolveActor({source:ev.source as any, raw:ev.raw});
  const cred = getHabitica(who.email);
  const when = fmtJST(ev.occurredAt);

  appendJsonl("data/events/appointments.jsonl",{at:new Date().toISOString(),day:isoDay(ev.occurredAt),callId:ev.callId,actor:who});

  if (!cred || DRY_RUN) {
    log(`[XP] appointment +${APPOINTMENT_XP}XP (DRY_RUN or no-cred) callId=${ev.callId} by=${who.name} @${when}`);
    return;
  }
  await habSafe(async ()=> {
    await addAppointment(cred, APPOINTMENT_XP, APPOINTMENT_BADGE_LABEL);
    return undefined as any;
  });
}

async function notifyChatworkAppointment(ev: Normalized){
  try {
    const who = resolveActor({source:ev.source as any, raw:ev.raw});
    await sendChatworkMessage(cwApptText(who.name));
  } catch {}
}

/* =============== Start =============== */
app.listen(PORT, ()=>{
  log(`listening :${PORT} DRY_RUN=${DRY_RUN} totalize=${CALL_TOTALIZE_5MIN} unit=${CALL_XP_UNIT_MS}ms per5min=${CALL_XP_PER_5MIN} perCall=${CALL_XP_PER_CALL}`);
  log(`[habitica] users=${Object.keys(HAB_MAP).length}, [name->email] entries=${Object.keys(NAME2MAIL).length}`);
  log(`[env] APPOINTMENT_XP=${APPOINTMENT_XP} DAILY_BONUS_XP=${DAILY_BONUS_XP}`);
  log(`[env] APPOINTMENT_VALUES=${JSON.stringify(APPOINTMENT_VALUES)}`);
});
export {};
