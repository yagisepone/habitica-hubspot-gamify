// src/lib/utils.ts
import fs from "fs";
import path from "path";
import crypto from "crypto";

export function log(...a: any[]) { console.log("[web]", ...a); }

export function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }
export function appendJsonl(fp: string, obj: any) { ensureDir(path.dirname(fp)); fs.appendFileSync(fp, JSON.stringify(obj) + "\n"); }
export function readJsonlAll(fp: string): any[] {
  try { return fs.readFileSync(fp, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)); } catch { return []; }
}

export function safeParse<T = any>(s?: string): T | undefined { try { return s ? JSON.parse(s) as T : undefined; } catch { return undefined; } }
export function normSpace(s?: string) { return (s || "").replace(/\u3000/g, " ").trim(); }

export function timingEqual(a: string, b: string) {
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

export function isoDay(d?: any) {
  const t = d instanceof Date ? d : (d ? new Date(d) : new Date());
  return t.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "-");
}
export function isoMonth(d?: any) {
  const t = d instanceof Date ? d : (d ? new Date(d) : new Date());
  return t.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).replace(/\//g, "-");
}
export function fmtJST(ms?: any) {
  const n = Number(ms); if (!Number.isFinite(n)) return "-";
  return new Date(n).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function jstYmd(d?: any) {
  const t = d instanceof Date ? d : (d ? new Date(d) : new Date());
  const parts = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(t);
  const m: any = {};
  for (const p of parts) if (p.type === "year" || p.type === "month" || p.type === "day") m[p.type] = Number(p.value);
  return { y: m.year, mo: m.month, d: m.day };
}
export function isMonthEndJST(d?: any) {
  const { y, mo, d: day } = jstYmd(d);
  if (!y || !mo || !day) return false;
  const last = new Date(y, mo, 0).getDate();
  return day === last;
}

export function numOrUndefined(v: any) {
  if (v == null) return undefined;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}
export function firstMatchKey(row: any, candidates: string[]): string | undefined {
  const keys = Object.keys(row || {});
  const lc = (x: string) => x.toLowerCase().replace(/\s+/g, "");
  const set = new Map(keys.map(k => [lc(k), k]));
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

export function parseApprovalAt(s?: string): Date | null {
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

/**
 * HubSpot v3 の sourceId から userId を抜く（例: "userId:81798571" -> "81798571"）
 * 旧 server.ts と同一仕様（数値だけを厳密に抽出）
 */
export function parseHubSpotSourceUserId(raw: any): string | undefined {
  const s = String(raw?.sourceId || raw?.source_id || "");
  const m = s.match(/userId:(\d+)/i);
  return m ? m[1] : undefined;
}

/**
 * 表示名をマップ（email -> name）で解決する。
 * a は { actor?: {name,email}, email?: string } などを想定。
 */
export function displayName(a: any, mail2name: Record<string, string>) {
  const em = (a?.actor?.email || a?.email || "").toLowerCase();
  if (em && mail2name[em]) return mail2name[em];
  const actorName = a?.actor?.name;
  if (actorName) return normSpace(actorName);
  return em ? (em.split?.("@")[0] || "担当者") : "担当者";
}
