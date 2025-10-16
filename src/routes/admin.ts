import { Request, Response } from "express";
import path from "path";
import { AUTH_TOKEN } from "../lib/env.js";
import { displayName, isoDay, isoMonth, readJsonlAll } from "../lib/utils.js";
import { MAIL2NAME, HAB_MAP, NAME2MAIL, ZOOM_UID2MAIL } from "../lib/maps.js";
import { promises as fs } from "fs";

const ADMIN_DIR = path.resolve(__dirname, "../public-admin");

function requireBearer(req: Request, res: Response): boolean {
  const token = (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!AUTH_TOKEN) { res.status(500).json({ ok: false, error: "missing AUTH_TOKEN" }); return false; }
  if (token !== AUTH_TOKEN) { res.status(401).json({ ok: false, error: "auth" }); return false; }
  return true;
}

export function dashboardHandler(_req: Request, res: Response) {
  const today = isoDay(), yest = isoDay(new Date(Date.now() - 86400000));
  const monthKey = isoMonth();
  const rd = (fp: string) => readJsonlAll(fp);
  const calls = rd("data/events/calls.jsonl");
  const appts = rd("data/events/appointments.jsonl");
  const apprs = rd("data/events/approvals.jsonl");
  const sales = rd("data/events/sales.jsonl");

  function isMonth(d: string) { return String(d || "").slice(0, 7) === monthKey; }

  function aggByDay(day: string) {
    const by: Record<string, any> = {};
    const nm = (a: any) => displayName(a, MAIL2NAME);
    for (const x of calls.filter(v => v.day === day)) { const k = nm(x); by[k] ??= { name: k, calls: 0, min: 0, appts: 0, apprs: 0, sales: 0 }; by[k].calls += 1; by[k].min += Math.round((x.ms || 0) / 60000); }
    for (const x of appts.filter(v => v.day === day)) { const k = nm(x); by[k] ??= { name: k, calls: 0, min: 0, appts: 0, apprs: 0, sales: 0 }; by[k].appts += 1; }
    for (const x of apprs.filter(v => v.day === day)) { const k = nm(x); by[k] ??= { name: k, calls: 0, min: 0, appts: 0, apprs: 0, sales: 0 }; by[k].apprs += 1; }
    for (const x of sales.filter(v => v.day === day)) { const k = nm(x); by[k] ??= { name: k, calls: 0, min: 0, appts: 0, apprs: 0, sales: 0 }; by[k].sales += Number(x.amount || 0); }
    for (const k of Object.keys(by)) { const v = by[k]; v.rate = v.appts > 0 ? Math.round((v.apprs / v.appts) * 100) : 0; }
    return Object.values(by).sort((a: any, b: any) => a.name.localeCompare(b.name));
  }

  function aggByMonth() {
    const by: Record<string, any> = {};
    const nm = (a: any) => displayName(a, MAIL2NAME);
    for (const x of calls.filter(v => isMonth(v.day))) { const k = nm(x); by[k] ??= { name: k, calls: 0, min: 0, appts: 0, apprs: 0, sales: 0 }; by[k].calls += 1; by[k].min += Math.round((x.ms || 0) / 60000); }
    for (const x of appts.filter(v => isMonth(v.day))) { const k = nm(x); by[k] ??= { name: k, calls: 0, min: 0, appts: 0, apprs: 0, sales: 0 }; by[k].appts += 1; }
    for (const x of apprs.filter(v => isMonth(v.day))) { const k = nm(x); by[k] ??= { name: k, calls: 0, min: 0, appts: 0, apprs: 0, sales: 0 }; by[k].apprs += 1; }
    for (const x of sales.filter(v => isMonth(v.day))) { const k = nm(x); by[k] ??= { name: k, calls: 0, min: 0, appts: 0, apprs: 0, sales: 0 }; by[k].sales += Number(x.amount || 0); }
    for (const k of Object.keys(by)) { const v = by[k]; v.rate = v.appts > 0 ? Math.round((v.apprs / v.appts) * 100) : 0; }
    return Object.values(by).sort((a: any, b: any) => a.name.localeCompare(b.name));
  }

  function aggMakersByDay(day: string) {
    const by: Record<string, { maker: string; count: number; sales: number }> = {};
    for (const x of apprs.filter(v => v.day === day)) { const m = (x.maker || "").trim(); if (!m) continue; by[m] ??= { maker: m, count: 0, sales: 0 }; by[m].count += 1; }
    for (const x of sales.filter(v => v.day === day)) { const m = (x.maker || "").trim(); if (!m) continue; by[m] ??= { maker: m, count: 0, sales: 0 }; by[m].sales += Number(x.amount || 0); }
    return Object.values(by).sort((a, b) => b.count - a.count || b.sales - a.sales || a.maker.localeCompare(b.maker));
  }

  function aggMakersByMonth() {
    const by: Record<string, { maker: string; count: number; sales: number }> = {};
    for (const x of apprs.filter(v => isMonth(v.day))) { const m = (x.maker || "").trim(); if (!m) continue; by[m] ??= { maker: m, count: 0, sales: 0 }; by[m].count += 1; }
    for (const x of sales.filter(v => isMonth(v.day))) { const m = (x.maker || "").trim(); if (!m) continue; by[m] ??= { maker: m, count: 0, sales: 0 }; by[m].sales += Number(x.amount || 0); }
    return Object.values(by).sort((a, b) => b.count - a.count || b.sales - a.sales || a.maker.localeCompare(b.maker));
  }

  const T = aggByDay(today), Y = aggByDay(yest), TM = aggMakersByDay(today), YM = aggMakersByDay(yest);
  const M = aggByMonth(), MM = aggMakersByMonth();

  const Row = (r: any) => `<tr><td>${r.name}</td><td style="text-align:right">${r.calls}</td><td style="text-align:right">${r.min}</td><td style="text-align:right">${r.appts}</td><td style="text-align:right">${r.apprs}</td><td style="text-align:right">${r.rate}%</td><td style="text-align:right">¥${(r.sales || 0).toLocaleString()}</td></tr>`;
  const RowM = (r: any) => `<tr><td>${r.maker}</td><td style="text-align:right">${r.count}</td><td style="text-align:right">¥${(r.sales || 0).toLocaleString()}</td></tr>`;
  const html = `<!doctype html><meta charset="utf-8"><title>ダッシュボード</title>
  <style>body{font-family:system-ui;margin:2rem}table{border-collapse:collapse;min-width:760px}th,td{border:1px solid #ddd;padding:.45rem .55rem}th{background:#f7f7f7}h2{margin-top:2rem}</style>
  <h1>ダッシュボード</h1>
  <h2>本日 ${today}</h2>
  <table><thead><tr><th>担当</th><th>コール</th><th>分</th><th>アポ</th><th>承認</th><th>承認率</th><th>売上</th></tr></thead><tbody>${T.map(Row).join("") || '<tr><td colspan="7">データなし</td></tr>'}</tbody></table>
  <h2>メーカー別（承認ベース） 本日 ${today}</h2>
  <table><thead><tr><th>メーカー</th><th>承認数</th><th>売上(合計)</th></tr></thead><tbody>${TM.map(RowM).join("") || '<tr><td colspan="3">データなし</td></tr>'}</tbody></table>
  <h2>月次（当月 ${monthKey}）</h2>
  <table><thead><tr><th>担当</th><th>コール</th><th>分</th><th>アポ</th><th>承認</th><th>承認率</th><th>売上</th></tr></thead><tbody>${M.map(Row).join("") || '<tr><td colspan="7">データなし</td></tr>'}</tbody></table>
  <h2>メーカー別（承認ベース） 月次 ${monthKey}</h2>
  <table><thead><tr><th>メーカー</th><th>承認数</th><th>売上(合計)</th></tr></thead><tbody>${MM.map(RowM).join("") || '<tr><td colspan="3">データなし</td></tr>'}</tbody></table>
  <h2>前日 ${yest}</h2>
  <table><thead><tr><th>担当</th><th>コール</th><th>分</th><th>アポ</th><th>承認</th><th>承認率</th><th>売上</th></tr></thead><tbody>${Y.map(Row).join("") || '<tr><td colspan="7">データなし</td></tr>'}</tbody></table>
  <h2>メーカー別（承認ベース） 前日 ${yest}</h2>
  <table><thead><tr><th>メーカー</th><th>承認数</th><th>売上(合計)</th></tr></thead><tbody>${YM.map(RowM).join("") || '<tr><td colspan="3">データなし</td></tr>'}</tbody></table>`;
  res.type("html").send(html);
}

export async function consoleHandler(_req: Request, res: Response) {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' https://api.hubapi.com https://api.hubspot.com https://*.onrender.com",
    "frame-ancestors https://habitica.com https://*.habitica.com *"
  ].join("; ");
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("X-Frame-Options", "");
  res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");
  res.setHeader("Cache-Control", "no-store");
  try {
    const html = await fs.readFile(path.join(ADMIN_DIR, "console.html"), "utf8");
    res.type("text/html").send(html);
  } catch (err) {
    res.status(500).send("Console not found");
  }
}

export function mappingHandler(req: Request, res: Response) {
  if (!requireBearer(req, res)) return;
  res.json({ ok: true, habiticaEmails: Object.keys(HAB_MAP).sort(), nameEmailEntries: Object.keys(NAME2MAIL).length, zoomUserIdMapCount: Object.keys(ZOOM_UID2MAIL).length });
}
