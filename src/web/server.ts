import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import dayjs from "dayjs";

type ByDateEntry = { calls: number; minutes: number; deals?: number; deltaPt: number };
type MemberState = { totalPt: number; streakDays: number; lastDate?: string; lastTitle?: string };
type StateShape = {
  byDate: Record<string, Record<string, ByDateEntry>>;
  byMember: Record<string, MemberState>;
};
type Member = {
  name: string;
  hubspotOwnerId: string;
  habiticaUserId?: string;
  habiticaApiToken?: string;
  email?: string;
};

export const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// ---- Basic認証（テスト時は無効化可能）----
const BASIC_USER = process.env.BASIC_USER;
const BASIC_PASS = process.env.BASIC_PASS;
const DISABLE_BASIC =
  process.env.BASIC_AUTH_DISABLE === "true" || process.env.NODE_ENV === "test";

function unauthorized(res: import("express").Response) {
  res.set("WWW-Authenticate", 'Basic realm="dashboard"');
  return res.status(401).send("Auth required");
}

if (BASIC_USER && BASIC_PASS && !DISABLE_BASIC) {
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || "";
    if (!hdr.startsWith("Basic ")) return unauthorized(res);
    const creds = Buffer.from(hdr.slice(6), "base64").toString().split(":");
    if (creds[0] === BASIC_USER && creds[1] === BASIC_PASS) return next();
    return unauthorized(res);
  });
}
// ---- /Basic認証 ----

app.use("/reports", express.static(path.resolve(process.cwd(), "reports")));
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString(); } }));

function loadState(): StateShape {
  const p = path.resolve(process.cwd(), "data/state.json");
  if (!fs.existsSync(p)) return { byDate: {}, byMember: {} };
  try {
    const obj = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (obj.byDate && obj.byMember) return obj as StateShape;
    return { byDate: {}, byMember: {} };
  } catch {
    return { byDate: {}, byMember: {} };
  }
}

function loadMembers(): Member[] {
  // 互換: config/members.json を読み込む
  const p = path.resolve(process.cwd(), "config/members.json");
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
}

function datesDesc(state: StateShape): string[] {
  return Object.keys(state.byDate).sort((a, b) => (a < b ? 1 : -1));
}

function buildHtml(opts: {
  title: string;
  date: string;
  rows: Array<{
    name: string;
    calls: number;
    minutes: number;
    deals: number;
    deltaPt: number;
    totalPt: number;
    title: string;
    streakDays: number;
  }>;
  dates: string[];
}) {
  const css = `
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:24px;background:#0b1220;color:#e6edf3}
  a{color:#9bdcff;text-decoration:none}
  .wrap{max-width:1000px;margin:0 auto}
  h1{font-size:20px;margin:0 0 12px}
  .meta{display:flex;gap:8px;align-items:center;margin:0 0 16px}
  select{background:#0b1a2a;color:#e6edf3;border:1px solid #294059;border-radius:8px;padding:6px 10px}
  table{width:100%;border-collapse:collapse;background:#0b1a2a;border:1px solid #223b50;border-radius:10px;overflow:hidden}
  th,td{padding:10px 12px;border-bottom:1px solid #223b50;text-align:right}
  th:nth-child(1),td:nth-child(1){text-align:left}
  tr:hover{background:#0e2134}
  .badge{display:inline-block;background:#123e2b;border:1px solid #1a6d48;color:#b6ffd0;padding:2px 8px;border-radius:999px;font-size:12px}
  .footer{margin-top:12px;color:#9fb3c8;font-size:12px}
  `;
  const dateOptions = opts.dates
    .map((d) => `<option value="${d}" ${d === opts.date ? "selected" : ""}>${d}</option>`)
    .join("");
  const rows = opts.rows
    .map(
      (r) => `
    <tr>
      <td>${r.name}</td>
      <td>${r.calls.toLocaleString()}</td>
      <td>${r.minutes.toLocaleString()}</td>
      <td>${r.deals.toLocaleString()}</td>
      <td>${r.deltaPt.toLocaleString()}</td>
      <td>${r.totalPt.toLocaleString()}</td>
      <td>${r.title}</td>
      <td>${r.streakDays}</td>
    </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${opts.title}</title><style>${css}</style></head>
<body>
<div class="wrap">
  <h1>営業ゲーミフィケーション ダッシュボード</h1>
  <div class="meta">
    <form method="GET" action="/day">
      <label for="d">日付</label>
      <select id="d" name="d" onchange="this.form.submit()">${dateOptions}</select>
    </form>
    <span class="badge">レポート: <a href="/reports/${opts.date}.md" target="_blank">${opts.date}.md</a></span>
  </div>
  <table>
    <thead><tr>
      <th>メンバー</th><th>架電</th><th>通話(分)</th><th>成約</th>
      <th>付与pt</th><th>累計pt</th><th>称号</th><th>連続日数</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="footer">最終更新: ${new Date().toLocaleString("ja-JP")}</div>
</div>
</body></html>`;
}

// health
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get("/healthz", (_req, res) => res.status(200).send("OK"));

// state JSON
app.get("/api/state", (_req, res) => res.json(loadState()));

// 最新日
app.get("/", (_req, res) => {
  const state = loadState();
  const members = loadMembers();
  const dates = datesDesc(state);
  const date = dates[0] || dayjs().format("YYYY-MM-DD");
  const day = state.byDate[date] || {};
  const rows = Object.keys(day)
    .map((ownerId) => {
      const m = members.find((x) => x.hubspotOwnerId === ownerId);
      const ms = state.byMember[ownerId] || { totalPt: 0, streakDays: 0, lastTitle: "" };
      const v = day[ownerId];
      return {
        name: m?.name || ownerId,
        calls: v.calls || 0,
        minutes: v.minutes || 0,
        deals: v.deals || 0,
        deltaPt: v.deltaPt || 0,
        totalPt: ms.totalPt || 0,
        title: ms.lastTitle || "",
        streakDays: ms.streakDays || 0
      };
    })
    .sort((a, b) => b.totalPt - a.totalPt);
  res.send(buildHtml({ title: "Dashboard", date, rows, dates }));
});

// 日付指定
app.get("/day", (req, res) => {
  const q = (req.query.d as string) || "";
  const state = loadState();
  const members = loadMembers();
  const dates = datesDesc(state);
  const date = dates.includes(q) ? q : dates[0] || dayjs().format("YYYY-MM-DD");
  const day = state.byDate[date] || {};
  const rows = Object.keys(day)
    .map((ownerId) => {
      const m = members.find((x) => x.hubspotOwnerId === ownerId);
      const ms = state.byMember[ownerId] || { totalPt: 0, streakDays: 0, lastTitle: "" };
      const v = day[ownerId];
      return {
        name: m?.name || ownerId,
        calls: v.calls || 0,
        minutes: v.minutes || 0,
        deals: v.deals || 0,
        deltaPt: v.deltaPt || 0,
        totalPt: ms.totalPt || 0,
        title: ms.lastTitle || "",
        streakDays: ms.streakDays || 0
      };
    })
    .sort((a, b) => b.totalPt - a.totalPt);
  res.send(buildHtml({ title: `Dashboard ${date}`, date, rows, dates }));
});

// ====== 起動関数 ======
export function start() {
  const server = app.listen(PORT, () => {
    console.log(`[web] listening on http://localhost:${PORT}`);
  });
  return server;
}

// 直接起動時のみ立ち上げ（Jest/テストでは起動しない）
const isJest = Boolean(process.env.JEST_WORKER_ID);
if (!isJest && process.env.NODE_ENV !== "test" && require.main === module) {
  start();
}
