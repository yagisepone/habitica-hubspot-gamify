// src/features/csv_handlers.ts
import { Request, Response } from "express";
import Busboy from "busboy";
import { parse as csvParse } from "csv-parse/sync";

import {
  APPOINTMENT_VALUES,
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
  safeParse,
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
      // ★ busboy は new しない（型エラーになるため）。関数呼び出しでOK
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
 *  CSV 正規化
 *   ・担当（名乗り or DXPORT 名 or email）を解決（社内ユーザのみ）
 *   ・ステータスが「承認」のみ採用
 *   ・承認日時で day/month 集計
 *   ・金額があれば sales も生成
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
    "メーカー",
    "メーカー名",
    "メーカー名（取引先）",
    "ブランド",
    "brand",
    "maker",
    "取引先名",
    "会社名",
    "メーカー（社名）",
  ];
  const C_AMOUNT = [
    "金額",
    "売上",
    "受注金額",
    "受注金額（税込）",
    "受注金額（税抜）",
    "売上金額",
    "売上金額（税込）",
    "売上金額（税抜）",
    "金額(円)",
    "amount",
    "price",
    "契約金額",
    "成約金額",
    "合計金額",
    "売上合計",
    "報酬",
    "追加報酬",
  ];
  const C_ID = ["id", "ID", "案件ID", "取引ID", "レコードID", "社内ID", "番号", "伝票番号", "管理番号"];
  const C_APPR_DT = ["承認日時", "承認日"];
  const C_STATUS = ["商談ステータス", "ステータス", "最終結果"];

  type Out = {
    type: "approval" | "sales";
    email?: string;
    name?: string;
    amount?: number;
    maker?: string;
    id?: string;
    date?: Date;
    notes?: string;
  };
  const out: Out[] = [];

  for (const r of recs) {
    // 担当者解決
    const actor = resolveActorFromRow(r);
    if (REQUIRE_DXPORT_NAME && !actor.name) continue;
    if (!isInternal(actor.name, actor.email)) continue;

    // ステータス=承認のみ
    const kStatus = firstMatchKey(r, C_STATUS);
    if (kStatus) {
      const s = String(r[kStatus] || "").trim();
      const sLc = s.toLowerCase();
      const ok = ["承認", "approved", "approve", "accepted", "合格"].some(
        (t) => s.includes(t) || sLc === t
      );
      if (!ok) continue;
    }

    // 承認日時
    const kApprDt = firstMatchKey(r, C_APPR_DT);
    const dateStr = kApprDt ? String(r[kApprDt] || "").trim() : "";
    const apprAt = parseApprovalAt(dateStr);
    if (!apprAt) continue;

    const kMaker = firstMatchKey(r, C_MAKER);
    const kAmt = firstMatchKey(r, C_AMOUNT);
    const kId = firstMatchKey(r, C_ID);

    const maker = kMaker ? String(r[kMaker] || "").toString().trim() : undefined;

    let amount = kAmt ? numOrUndefined(r[kAmt]) : undefined;
    if (kAmt && /報酬/.test(kAmt)) {
      const addKey = firstMatchKey(r, ["追加報酬"]);
      if (addKey) {
        const add = numOrUndefined(r[addKey]);
        if (Number.isFinite(add as number)) amount = (amount || 0) + (add as number);
      }
    }

    const rid = kId ? String(r[kId] || "").toString().trim() : undefined;

    // approval は必ず1件
    out.push({
      type: "approval",
      email: actor.email,
      name: actor.name,
      maker,
      id: rid,
      date: apprAt,
      notes: "from CSV(approved)",
    });

    // 金額があれば sales も
    if (amount && amount > 0) {
      out.push({
        type: "sales",
        email: actor.email,
        name: actor.name,
        amount,
        maker,
        id: rid,
        date: apprAt,
        notes: "from CSV(approved+amount)",
      });
    }
  }

  return out;
}

/* ---------- 行→担当者解決（名乗り > DXPort記述 > email） ---------- */
function resolveActorFromRow(r: any): { name?: string; email?: string } {
  const K_NANORI = ["名乗り", "名乗り（DXPort）", "名乗り（dxport）", "名乗り（ＤＸＰｏｒｔ）"];
  const kNanori = firstMatchKey(r, K_NANORI);
  if (kNanori) {
    const raw = String(r[kNanori] || "");
    const nameJp = extractDxPortNameFromText(raw) || String(raw).replace(/\u3000/g, " ").trim();
    if (nameJp) {
      const email = NAME2MAIL[nameJp];
      return { name: nameJp, email };
    }
  }

  const K_DX = [
    "承認条件 回答23",
    "承認条件 回答２３",
    "DXPortの",
    "DX PORTの",
    "DXPortの担当者",
    "獲得者",
    "DX Portの",
    "DXportの",
    "dxportの",
    "dx portの",
    "自由記述",
    "備考（dxport）",
    "dxport 備考",
  ];
  const C_EMAIL = [
    "email",
    "mail",
    "担当者メール",
    "担当者 メール",
    "担当者 メールアドレス",
    "担当メール",
    "担当者email",
    "owner email",
    "オーナー メール",
    "ユーザー メール",
    "営業担当メール",
    "担当者e-mail",
    "担当e-mail",
    "担当者メールアドレス",
    "担当者のメール",
  ];

  const kDx = firstMatchKey(r, K_DX);
  if (kDx) {
    const nameJp = extractDxPortNameFromText(String(r[kDx] || ""));
    if (nameJp) {
      const email = NAME2MAIL[nameJp];
      return { name: nameJp, email };
    }
  }
  const kEmail = firstMatchKey(r, C_EMAIL);
  if (kEmail) {
    const e = String(r[kEmail] || "").toLowerCase().trim();
    if (e) return { name: MAIL2NAME[e] || e.split("@")[0], email: e };
  }
  return {};
}

// DXPort の自由記述から氏名を抽出
function extractDxPortNameFromText(s?: string): string | undefined {
  const t = String(s || "").replace(/\u3000/g, " ").trim();
  if (!t) return undefined;
  const m = t.match(/D\s*X\s*(?:P\s*O\s*R\s*T)?\s*の\s*([^\s].*)$/i);
  if (m && m[1]) return String(m[1]).replace(/\u3000/g, " ").trim();
  return undefined;
}

/* ============================================================
 *  重複防止のキー管理（UPSERT）
 * ============================================================ */
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
function timeKey(d?: Date): string {
  return d ? new Date(d).toISOString() : "";
}

/* ============================================================
 *  集計・配布ユーティリティ
 * ============================================================ */
function writeCompanyStepsLedger(entry: { month: string; steps: number; totalAmount: number }) {
  appendJsonl("data/awards/company_sales_steps.jsonl", {
    at: new Date().toISOString(),
    month: entry.month,
    steps: entry.steps,
    newSteps: entry.steps,
    totalAmount: entry.totalAmount,
  });
}
function sumCompanyMonthlySalesAmount(month: string) {
  const recs = readJsonlAll("data/events/sales.jsonl");
  let sum = 0;
  for (const r of recs) {
    const d = String(r.day || "");
    if (!d || d.slice(0, 7) !== month) continue;
    sum += Number(r.amount || 0);
  }
  return sum;
}

/* ============================================================
 *  メイン：CSV反映（検出 / 実行）
 * ============================================================ */

// 検出だけ（プレビュー）
export async function csvDetect(req: Request, res: Response) {
  const text = await readCsvTextFromReq(req);
  if (!text) return res.status(400).json({ ok: false, error: "empty CSV" });

  const out = normalizeCsv(text);
  const daySet = new Set(out.map((r) => isoDay(r.date)));
  const monthSet = new Set(out.map((r) => isoMonth(r.date)));

  // 種別集計
  let appr = 0,
    sales = 0,
    makers = 0;
  const makerCount: Record<string, number> = {};
  const salesSumByMaker: Record<string, number> = {};

  for (const r of out) {
    if (r.type === "approval") {
      appr++;
      if (r.maker) makerCount[r.maker] = (makerCount[r.maker] || 0) + 1;
    }
    if (r.type === "sales" && r.amount) {
      sales++;
      const m = r.maker || "(unknown)";
      salesSumByMaker[m] = (salesSumByMaker[m] || 0) + r.amount;
    }
  }
  makers = Object.keys(makerCount).length;

  res.json({
    ok: true,
    rows: out.length,
    days: Array.from(daySet),
    months: Array.from(monthSet),
    approvals: appr,
    sales,
    makers,
    makerCount,
    salesSumByMaker,
  });
}

// 実行（付与）
export async function csvUpsert(req: Request, res: Response) {
  // 認証（クエリ or ヘッダ）
  const token =
    String((req.query as any).token || "").trim() ||
    String(req.headers["x-auth-token"] || "").trim();
  const allow =
    !!token &&
    (token === AUTH_TOKEN ||
      String(CSV_UPLOAD_TOKENS ?? "")
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean)
        .includes(token));
  if (!allow) return res.status(401).json({ ok: false, error: "auth" });

  const text = await readCsvTextFromReq(req);
  if (!text) return res.status(400).json({ ok: false, error: "empty CSV" });

  const out = normalizeCsv(text);

  // 重複防止セット
  const setAppr = readKeySet(FP_IDX_APPR);
  const setSales = readKeySet(FP_IDX_SALES);

  // 集計用
  let countAppr = 0;
  let countSales = 0;
  const makerCount: Record<string, number> = {};
  const salesSumByMaker: Record<string, number> = {};

  for (const r of out) {
    const day = isoDay(r.date);
    const month = isoMonth(r.date);

    if (r.type === "approval") {
      const key =
        `appr:${day}:${r.email || r.name}:${r.maker || ""}:${r.id || ""}`.replace(/\s+/g, "_");
      if (setAppr.has(key)) continue;

      // Habitica 付与
      const cred = getHabitica(r.email);
      if (cred && !DRY_RUN) {
        await habSafe(async () => {
          await addApproval(cred, 0, r.notes || "CSV");
          return undefined as any;
        });
      }
      appendKey(FP_IDX_APPR, key);
      appendJsonl("data/events/approvals.jsonl", {
        at: new Date().toISOString(),
        day,
        month,
        email: r.email,
        name: r.name,
        maker: r.maker,
        id: r.id,
      });
      countAppr++;
      if (r.maker) makerCount[r.maker] = (makerCount[r.maker] || 0) + 1;

      // Chatwork 通知（承認）
      try {
        if (r.name) await sendChatworkMessage(cwApprovalText(r.name, r.maker));
      } catch {}
    }

    if (r.type === "sales" && r.amount) {
      const key =
        `sales:${day}:${r.email || r.name}:${r.maker || ""}:${r.id || ""}:${r.amount}`.replace(
          /\s+/g,
          "_"
        );
      if (setSales.has(key)) continue;

      // Habitica 付与（10万円/50XP などは connector 側ルール）
      const cred = getHabitica(r.email);
      if (cred && !DRY_RUN) {
        await habSafe(async () => {
          await addSales(cred, r.amount!, r.notes || "CSV");
          return undefined as any;
        });
      }
      appendKey(FP_IDX_SALES, key);
      appendJsonl("data/events/sales.jsonl", {
        at: new Date().toISOString(),
        day,
        month,
        email: r.email,
        name: r.name,
        maker: r.maker,
        id: r.id,
        amount: r.amount,
      });
      countSales++;

      // Chatwork 通知（売上）
      try {
        if (r.name) await sendChatworkMessage(cwSalesText(r.name, r.amount, r.maker));
      } catch {}

      // メーカー別集計
      const m = r.maker || "(unknown)";
      salesSumByMaker[m] = (salesSumByMaker[m] || 0) + r.amount!;
    }
  }

  // メーカー賞（最多メーカーの担当に🏆）
  try {
    const topMaker = Object.entries(makerCount).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (topMaker) {
      // 最多メーカーに対して、関係者の中からエントリ1件目の人に付与（シンプル）
      const first = out.find((r) => r.maker === topMaker && r.type === "approval");
      if (first?.email) {
        const cred = getHabitica(first.email);
        if (cred && !DRY_RUN) {
          await habSafe(async () => {
            await addMakerAward(cred, 1);
            return undefined as any;
          });
        }
        // Chatwork メーカー別成果
        try {
          const disp = displayName({ email: first.email, actor: { name: first.name } }, MAIL2NAME);
          await sendChatworkMessage(
            cwMakerAchievementText(disp, topMaker, makerCount[topMaker], salesSumByMaker[topMaker])
          );
        } catch {}
      }
    }
  } catch (e) {
    log(`[csv] maker award error: ${String((e as any)?.message || e)}`);
  }

  // 会社合計を全体配布（ON時）
  try {
    if (String(COMPANY_SALES_TO_ALL || "") === "1") {
      const months = new Set(out.map((r) => isoMonth(r.date)));
      for (const m of months) {
        const totalAmount = sumCompanyMonthlySalesAmount(m);
        const steps = Math.floor(totalAmount / Number(SALES_XP_STEP_YEN || 100000));
        if (steps > 0) {
          // 全員に steps * SALES_XP_PER_STEP を配布
          const per = steps * Number(SALES_XP_PER_STEP || 50);
          for (const email of Object.keys(HAB_MAP || {})) {
            const cred = getHabitica(email);
            if (cred && !DRY_RUN) {
              await habSafe(async () => {
                await addSales(cred, steps * Number(SALES_XP_STEP_YEN || 100000), `company_total ${m}`);
                return undefined as any;
              });
            }
          }
          writeCompanyStepsLedger({ month: m, steps, totalAmount });
        }
      }
    }
  } catch (e) {
    log(`[csv] company distribution error: ${String((e as any)?.message || e)}`);
  }

  // Chatwork サマリ通知
  try {
    const today = isoDay();
    await sendChatworkMessage(
      `CSV取込（${today}）\n承認 ${countAppr} / 売上 ${countSales} / メーカー ${Object.keys(makerCount).length}`
    );
  } catch {}

  res.json({
    ok: true,
    approvals: countAppr,
    sales: countSales,
    makers: Object.keys(makerCount).length,
  });
}
