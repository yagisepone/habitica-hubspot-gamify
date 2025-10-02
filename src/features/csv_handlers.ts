// src/features/csv_handlers.ts  — server.ts 等価移植版
import { Request, Response } from "express";
import Busboy from "busboy";
import { parse as csvParse } from "csv-parse/sync";

import {
  APPOINTMENT_VALUES, // 使わないが互換のため残す
  AUTH_TOKEN,
  COMPANY_SALES_TO_ALL,
  CSV_UPLOAD_TOKENS,
  DRY_RUN,
  REQUIRE_DXPORT_NAME,
  SALES_XP_PER_STEP,
  SALES_XP_STEP_YEN,
} from "../lib/env.js";

import {
  appendJsonl,
  displayName,
  firstMatchKey,
  isoDay,
  isoMonth,
  log,
  numOrUndefined,
  parseApprovalAt,
  readJsonlAll,
} from "../lib/utils.js";

import { getHabitica, isInternal, MAIL2NAME, NAME2MAIL, HAB_MAP } from "../lib/maps.js";
import { habSafe } from "../lib/habiticaQueue.js";

import { addApproval, addMakerAward, addSales } from "../connectors/habitica.js";
import {
  cwApprovalText,
  cwMakerAchievementText,
  cwSalesText,
  sendChatworkMessage,
} from "../connectors/chatwork.js";

/* ============================================================
 *  リクエストからCSVテキストを取り出す（Content-Typeに依存しない）
 * ============================================================ */
export async function readCsvTextFromReq(req: Request): Promise<string> {
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

/* ============================================================
 *  CSV 正規化（旧 server.ts と同等）
 * ============================================================ */
export function normalizeCsv(text: string) {
  const recs: any[] = csvParse(text, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  const C_MAKER = [
    "メーカー","メーカー名","メーカー名（取引先）","ブランド","brand","maker","取引先名","会社名","メーカー（社名）",
  ];
  const C_AMOUNT = [
    "金額","売上","受注金額","受注金額（税込）","受注金額（税抜）","売上金額","売上金額（税込）","売上金額（税抜）",
    "金額(円)","amount","price","契約金額","成約金額","合計金額","売上合計","報酬","追加報酬",
  ];
  const C_ID = ["id","ID","案件ID","取引ID","レコードID","社内ID","番号","伝票番号","管理番号"];
  const C_APPR_DT = ["承認日時","承認日"]; // day に使う
  const C_STATUS  = ["商談ステータス","ステータス","最終結果"]; // 「承認」のみ

  type Out = {type:"approval"|"sales"; email?:string; name?:string; amount?:number; maker?:string; id?:string; date?:Date; notes?:string};
  const out: Out[] = [];

  for (const r of recs) {
    // 1) 社内アポインター判定
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

    // 3) 承認日時（必須）
    const kApprDt = firstMatchKey(r, C_APPR_DT);
    const dateStr = kApprDt ? String(r[kApprDt]||"").trim() : "";
    const apprAt = parseApprovalAt(dateStr);
    if (!apprAt) continue;

    // 4) 付随情報
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

    out.push({ type:"approval", email:actor.email, name:actor.name, maker, id: rid, date: apprAt, notes:"from CSV(approved)" });
    if (amount && amount>0) {
      out.push({ type:"sales", email:actor.email, name:actor.name, amount, maker, id: rid, date: apprAt, notes:"from CSV(approved+amount)" });
    }
  }
  return out;
}

/* ---------- 行→担当者解決（名乗り > DXPort記述 > email） ---------- */
function resolveActorFromRow(r:any): {name?:string; email?:string} {
  const K_NANORI = ["名乗り","名乗り（DXPort）","名乗り（dxport）","名乗り（ＤＸＰｏｒｔ）"];
  const kNanori = firstMatchKey(r, K_NANORI);
  if (kNanori) {
    const raw = String(r[kNanori] || "");
    const nameJp = extractDxPortNameFromText(raw) || String(raw).replace(/\u3000/g," ").trim();
    if (nameJp) {
      const email = NAME2MAIL[nameJp];
      return { name: nameJp, email };
    }
  }

  const K_DX = ["承認条件 回答23","承認条件 回答２３","DXPortの","DX PORTの","DXPortの担当者","獲得者","DX Portの","DXportの","dxportの","dx portの","自由記述","備考（dxport）","dxport 備考"];
  const C_EMAIL = ["email","mail","担当者メール","担当者 メール","担当者 メールアドレス","担当メール","担当者email","owner email","オーナー メール","ユーザー メール","営業担当メール","担当者e-mail","担当e-mail","担当者メールアドレス","担当者のメール"];

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

// DXPort の自由記述から氏名を抽出
function extractDxPortNameFromText(s?: string): string|undefined {
  const t = String(s || "").replace(/\u3000/g," ").trim();
  if (!t) return undefined;
  const m = t.match(/D\s*X\s*(?:P\s*O\s*R\s*T)?\s*の\s*([^\s].*)$/i);
  if (m && m[1]) return String(m[1]).replace(/\u3000/g," ").trim();
  return undefined;
}

/* ============================================================
 *  認証（旧 server.ts と同じ）
 * ============================================================ */
function requireBearerCsv(req: Request, res: Response): boolean {
  const auth = String(req.header("authorization")||"");
  const token = auth.replace(/^Bearer\s+/i,"").trim();
  const list = String(CSV_UPLOAD_TOKENS||"").split(",").map(s=>s.trim()).filter(Boolean);
  if (!AUTH_TOKEN && list.length===0) { res.status(500).json({ok:false,error:"missing tokens"}); return false; }
  if (token && token===AUTH_TOKEN) return true;
  if (token && list.includes(token)) return true;
  res.status(401).json({ok:false,error:"auth"}); return false;
}

/* ============================================================
 *  UPSERT のキー（旧 server.ts と同じ）
 * ============================================================ */
const FP_IDX_APPR = "data/index/csv_approval_keys.jsonl";
const FP_IDX_SALES = "data/index/csv_sales_keys.jsonl";

function readKeySet(fp: string): Set<string> {
  const rows = readJsonlAll(fp);
  const s = new Set<string>();
  for (const r of rows) { const k = String(r.k ?? r.key ?? ""); if (k) s.add(k); }
  return s;
}
function appendKey(fp: string, k: string) { appendJsonl(fp, { k, at: new Date().toISOString() }); }
function timeKey(d?: Date){ return d ? new Date(d).toISOString() : ""; }
function personKey(email?: string, name?: string){ return (email && email.trim()) ? `e:${email.toLowerCase()}` : `n:${String(name||"").replace(/\u3000/g," ").trim()}`; }
function keyApproval(args:{date?:Date; maker?:string; email?:string; name?:string}) {
  return `a|${timeKey(args.date)}|${String(args.maker||"").trim()}|${personKey(args.email,args.name)}`;
}
function keySales(args:{date?:Date; maker?:string; email?:string; name?:string; amount?:number}) {
  const amt = Number(args.amount||0);
  return `s|${timeKey(args.date)}|${String(args.maker||"").trim()}|${personKey(args.email,args.name)}|${amt}`;
}

/* ============================================================
 *  月次累積（個人）／会社合計（全員配布）— 旧ロジック
 * ============================================================ */
// 個人：ledger
function readSalesStepsLedger(): Map<string, number> {
  const rows = readJsonlAll("data/awards/sales_month_steps.jsonl");
  const m = new Map<string, number>();
  for (const r of rows) {
    const kk = `${String(r.month||"")}|${String(r.email||"").toLowerCase()}|${String(r.maker||"")}`;
    const steps = Number(r.steps||0);
    if (kk && Number.isFinite(steps)) m.set(kk, steps);
  }
  return m;
}
function writeSalesStepsLedger(entry: { month:string; email:string; maker:string; steps:number; totalAmount:number; newSteps:number }) {
  appendJsonl("data/awards/sales_month_steps.jsonl", {
    at: new Date().toISOString(),
    month: entry.month,
    email: entry.email,
    maker: entry.maker,
    steps: entry.steps,
    newSteps: entry.newSteps,
    totalAmount: entry.totalAmount
  });
}
function keyOfMonthEmailMaker(month:string,email:string,maker:string){ return `${month}|${email}|${maker}`; }
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
type SalesTouched = { month:string; email:string; maker:string };
async function awardMonthlyCumulativeFor(touched: SalesTouched[]){
  if (!touched.length) return;
  const uniq = Array.from(new Set(touched.map(t=>keyOfMonthEmailMaker(t.month,t.email,t.maker))))
              .map(s=>{ const [month,email,maker] = s.split("|"); return {month,email,maker} as SalesTouched; });

  const ledger = readSalesStepsLedger();
  for (const k of uniq) {
    if (!k.email) continue;
    const cred = getHabitica(k.email);
    if (!cred && !DRY_RUN) continue;

    const totalAmt = sumMonthlySalesAmount(k.month, k.email, k.maker);
    if (totalAmt <= 0) continue;

    const stepsNow = Math.floor(totalAmt / Number(SALES_XP_STEP_YEN || 100000));
    const prev = ledger.get(keyOfMonthEmailMaker(k.month,k.email,k.maker)) || 0;
    const delta = stepsNow - prev;
    if (delta <= 0) continue;

    const addAmount = Number(SALES_XP_STEP_YEN || 100000) * delta;
    if (!DRY_RUN && cred) {
      await habSafe(async ()=>{ await addSales(cred, addAmount, `CSV monthly cumulative ${k.maker} ${k.month} (+${delta} step)`); return undefined as any; });
    } else {
      log(`[sales-cum] DRY_RUN or no-cred: email=${k.email} maker=${k.maker} month=${k.month} total=¥${totalAmt.toLocaleString()} stepsNow=${stepsNow} +${delta}`);
    }
    writeSalesStepsLedger({ month:k.month, email:k.email, maker:k.maker, steps:stepsNow, totalAmount:totalAmt, newSteps:delta });
  }
}

// 会社合計：ledger
function readCompanyStepsLedger(): Map<string, number> {
  const rows = readJsonlAll("data/awards/company_sales_steps.jsonl");
  const m = new Map<string, number>();
  for (const r of rows) {
    const mo = String(r.month||"");
    const steps = Number(r.steps||0);
    if (mo && Number.isFinite(steps)) m.set(mo, steps);
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
async function awardCompanyCumulativeForMonths(months: string[]) {
  if (String(COMPANY_SALES_TO_ALL||"")!=="1") return;
  const uniq = Array.from(new Set(months.filter(Boolean)));
  if (!uniq.length) return;

  const ledger = readCompanyStepsLedger();
  for (const month of uniq) {
    const totalAmt = sumCompanyMonthlySalesAmount(month);
    if (totalAmt <= 0) continue;

    const stepsNow = Math.floor(totalAmt / Number(SALES_XP_STEP_YEN || 100000));
    const prev = ledger.get(month) || 0;
    const delta = stepsNow - prev;
    if (delta <= 0) continue;

    const addAmount = Number(SALES_XP_STEP_YEN || 100000) * delta;
    const members = Object.entries(HAB_MAP);
    let awarded = 0;

    if (!DRY_RUN) {
      for (const [_email, cred] of members) {
        if (!cred) continue;
        await habSafe(async ()=>{ await addSales(cred, addAmount, `CSV company monthly cumulative ${month} (+${delta} step)`); return undefined as any; });
        awarded++;
      }
    } else {
      log(`[company-cum] DRY_RUN: month=${month} total=¥${totalAmt.toLocaleString()} stepsNow=${stepsNow} +${delta} toAll=${members.length}`);
      awarded = members.length;
    }
    writeCompanyStepsLedger({ month, steps: stepsNow, totalAmount: totalAmt, newSteps: delta });
  }
}

/* ============================================================
 *  検出（プレビュー）
 * ============================================================ */
export async function csvDetect(req: Request, res: Response) {
  const text = await readCsvTextFromReq(req);
  if (!text) return res.status(400).json({ ok: false, error: "empty CSV" });

  const out = normalizeCsv(text);
  const daySet = new Set(out.map((r) => isoDay(r.date)));
  const monthSet = new Set(out.map((r) => isoMonth(r.date)));

  let appr = 0, sales = 0;
  const makerCount: Record<string, number> = {};
  const salesSumByMaker: Record<string, number> = {};

  for (const r of out) {
    if (r.type === "approval") {
      appr++; if (r.maker) makerCount[r.maker] = (makerCount[r.maker] || 0) + 1;
    }
    if (r.type === "sales" && r.amount) {
      sales++; const m = r.maker || "(unknown)";
      salesSumByMaker[m] = (salesSumByMaker[m] || 0) + r.amount;
    }
  }

  res.json({
    ok: true,
    rows: out.length,
    days: Array.from(daySet),
    months: Array.from(monthSet),
    approvals: appr,
    sales,
    makers: Object.keys(makerCount).length,
    makerCount,
    salesSumByMaker,
  });
}

/* ============================================================
 *  実行（旧 server.ts と完全一致）
 * ============================================================ */
const CW_PER_ROW = false; // 旧仕様：行ごとのChatworkはオフ（サマリのみ）

export async function csvUpsert(req: Request, res: Response) {
  if (!requireBearerCsv(req,res)) return;

  const text = await readCsvTextFromReq(req);
  if (!text) return res.status(400).json({ ok: false, error: "empty CSV" });

  const normalized = normalizeCsv(text);

  // 重複防止セット（永続）
  const seenAppr = readKeySet(FP_IDX_APPR);
  const seenSales = readKeySet(FP_IDX_SALES);

  let nA=0, nS=0, sum=0, dup=0;
  const makerCount: Record<string, number> = {};
  const salesSumByMaker: Record<string, number> = {};

  const touched: SalesTouched[] = [];        // 個人累積用 (month,email,maker)
  const touchedMonths = new Set<string>();   // 会社累積用 (month)

  for (const r of normalized) {
    const actorName = r.name || (r.email ? (MAIL2NAME[r.email] || r.email.split("@")[0]) : "担当者");
    const email = r.email ? String(r.email).toLowerCase() : undefined;
    const amount = r.amount != null ? Number(r.amount) : undefined;
    const maker = r.maker ? String(r.maker).trim() : undefined;
    const id = String(r.id || `${r.type}:${actorName}:${maker||"-"}`).trim();
    const date = r.date;
    const day = isoDay(date);

    if (r.type==="approval") {
      const k = keyApproval({date, maker, email, name:actorName});
      if (seenAppr.has(k)) { dup++; continue; }
      seenAppr.add(k); appendKey(FP_IDX_APPR, k);

      nA++;
      appendJsonl("data/events/approvals.jsonl",{ at:new Date().toISOString(), day, email, actor:{name:actorName, email}, id, maker });
      if (!DRY_RUN) {
        const cred = getHabitica(email);
        if (cred) await habSafe(()=>addApproval(cred,1,"CSV").then(()=>undefined as any));
      }
      if (CW_PER_ROW) { try { await sendChatworkMessage(cwApprovalText(actorName, maker)); } catch {} }
      if (maker) makerCount[maker] = (makerCount[maker]||0) + 1;
    }

    if (r.type==="sales") {
      const k = keySales({date, maker, email, name:actorName, amount});
      if (seenSales.has(k)) { dup++; continue; }
      seenSales.add(k); appendKey(FP_IDX_SALES, k);

      nS++; sum+=(amount||0);
      appendJsonl("data/events/sales.jsonl",{ at:new Date().toISOString(), day, email, actor:{name:actorName, email}, id, maker, amount });

      // 個人累積用キー（email & maker 必須）
      if (email && maker) touched.push({ month: String(day).slice(0,7), email, maker });

      // 会社累積の当月キー
      touchedMonths.add(String(day).slice(0,7));

      // per-row 付与：閾値未満のときのみ（>=閾値は累積側へ）
      if (!DRY_RUN) {
        const cred = getHabitica(email);
        if (cred && amount && amount > 0 && amount < Number(SALES_XP_STEP_YEN || 100000)) {
          await habSafe(()=>addSales(cred, amount, "CSV (per-row < step)").then(()=>undefined as any));
        }
      }
      if (CW_PER_ROW) { try { await sendChatworkMessage(cwSalesText(actorName, amount, maker)); } catch {} }

      const m2 = maker || "(unknown)";
      salesSumByMaker[m2] = (salesSumByMaker[m2]||0) + (amount||0);
    }
  }

  /* ===== 追加：メーカー賞（当日） ===== */
  try {
    const today = isoDay();
    const apprsToday = readJsonlAll("data/events/approvals.jsonl").filter(x => String(x.day||"") === today);
    type Entry = { name:string; email?:string; makerCounts: Record<string, number> };
    const byActor: Record<string, Entry> = {};
    const actorKey = (a:any) => (String(a?.actor?.email || a?.email || "") || displayName(a, MAIL2NAME)).toLowerCase();

    for (const a of apprsToday) {
      const key = actorKey(a);
      const email = String(a?.actor?.email || a?.email || "").toLowerCase() || undefined;
      const name = displayName(a, MAIL2NAME);
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
        if (!em || already.has(em)) continue;
        const cred = getHabitica(em);
        if (!DRY_RUN && cred) {
          await habSafe(()=>addMakerAward(cred,1).then(()=>undefined as any));
        }
        appendJsonl("data/events/maker_awards.jsonl", { at: new Date().toISOString(), day: today, email: em, actor: { name: w.name, email: em }, topCount: best });
      }
    }
  } catch (e:any) {
    log(`[csv] maker award (daily) error: ${e?.message||e}`);
  }

  /* ===== 月末メーカー賞（当月最大） ===== */
  try {
    const now = new Date();
    const j = new Intl.DateTimeFormat("ja-JP",{ timeZone: "Asia/Tokyo", year:"numeric", month:"numeric", day:"numeric" }).formatToParts(now);
    const parts:any = {}; for (const p of j) if (p.type==="year"||p.type==="month"||p.type==="day") parts[p.type]=Number(p.value);
    const last = new Date(parts.year, parts.month, 0).getDate();
    if (parts.day === last) {
      const monthKey = isoMonth();
      type Entry = { name:string; email?:string; makerCounts: Record<string, number> };
      const byActor: Record<string, Entry> = {};
      const apprsAll = readJsonlAll("data/events/approvals.jsonl");
      const apprsMonth = apprsAll.filter(x => String(x.day||"").slice(0,7) === monthKey);
      const actorKey = (a:any) => (String(a?.actor?.email || a?.email || "") || displayName(a, MAIL2NAME)).toLowerCase();

      for (const a of apprsMonth) {
        const key = actorKey(a);
        const email = String(a?.actor?.email || a?.email || "").toLowerCase() || undefined;
        const name = displayName(a, MAIL2NAME);
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
        const monthlyLog = readJsonlAll("data/events/maker_awards_monthly.jsonl");
        const already = new Set(
          monthlyLog.filter((x:any)=> String(x.month||"")===monthKey)
                    .map((x:any)=> String(x.email || x?.actor?.email || "").toLowerCase())
        );
        for (const w of winners) {
          const em = (w.email||"").toLowerCase();
          if (!em || already.has(em)) continue;
          const cred = getHabitica(em);
          if (!DRY_RUN && cred) {
            await habSafe(()=>addMakerAward(cred,1).then(()=>undefined as any));
          }
          appendJsonl("data/events/maker_awards_monthly.jsonl", { at: new Date().toISOString(), month: monthKey, email: em, actor: { name: w.name, email: em }, topCount: best });
        }
      }
    }
  } catch (e:any) {
    log(`[csv] maker award (monthly) error: ${e?.message||e}`);
  }

  /* ===== 個人/月次累積 & 会社合計（差分のみ） ===== */
  try { await awardMonthlyCumulativeFor(touched); } catch(e:any){ log(`[sales-cumulative] failed: ${e?.message||e}`); }
  try { await awardCompanyCumulativeForMonths(Array.from(touchedMonths)); } catch(e:any){ log(`[company-cumulative] failed: ${e?.message||e}`); }

  /* ===== Chatwork サマリ（旧仕様の簡易版タイトルだけ差し替え） ===== */
  try {
    const today = isoDay();
    await sendChatworkMessage(`📦 CSV取込サマリー（承認日時ベース）\n📅 本日 ${today}\n  承認: ${nA}件　💴 売上: ¥${sum.toLocaleString()}（${nS}件）`);
  } catch {}

  res.json({ ok: true, mode:"upsert", approvals: nA, sales: nS, makers: Object.keys(makerCount).length });
}
