import 'dotenv/config';
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import tz from "dayjs/plugin/timezone";
import { fetchDailyCallStats } from "../connectors/hubspot";
// 将来: import { addXpForKpi } from "../connectors/habitica";
import {
  calcDailyPoints, pickTitle, checkBadges,
  judgeStreakAchieve, streakBonus, buildAnnouncements
} from "../engine/skillEngine";

dayjs.extend(utc);
dayjs.extend(tz);

// ===== 型 =====
type Member = { name: string; hubspotOwnerId: string; habiticaUserId: string; habiticaApiToken: string; };
type MemberState = {
  totalPt: number;
  streakDays: number;
  lastDate?: string; // "YYYY-MM-DD"
  lastTitle?: string;
};
type Stat = { calls: number; minutes: number; deals?: number };
type ByDateEntry = { calls: number; minutes: number; deals?: number; deltaPt: number };
type StateShape = {
  byDate: Record<string, Record<string, ByDateEntry>>;
  byMember: Record<string, MemberState>;
};

// ===== ユーティリティ =====
function loadYaml<T = any>(rel: string): T {
  const p = path.resolve(process.cwd(), rel);
  return yaml.load(fs.readFileSync(p, "utf-8")) as T;
}
function loadMembers(): Member[] {
  const p = path.resolve(process.cwd(), "config/members.json");
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

// 旧フォーマットから自動移行
function loadState(): { path: string; obj: StateShape } {
  const p = path.resolve(process.cwd(), "data/state.json");
  if (!fs.existsSync(path.dirname(p))) fs.mkdirSync(path.dirname(p), { recursive: true });

  let parsed: any = null;
  if (fs.existsSync(p)) {
    try {
      parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      fs.copyFileSync(p, p + ".bak.parse_error");
      parsed = null;
    }
  }

  let state: StateShape;

  if (parsed && typeof parsed === "object" && parsed.byDate && parsed.byMember) {
    state = parsed as StateShape;
  } else if (parsed && typeof parsed === "object") {
    // 旧: { "YYYY-MM-DD": { owner: {calls, minutes,...}}, ... }
    const byDate: Record<string, Record<string, ByDateEntry>> = {};
    const byMember: Record<string, MemberState> = {};
    for (const k of Object.keys(parsed)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k)) {
        const dayObj = parsed[k] || {};
        byDate[k] = {};
        for (const ownerId of Object.keys(dayObj)) {
          const v = dayObj[ownerId] || {};
          byDate[k][ownerId] = {
            calls: Number(v.calls || 0),
            minutes: Number(v.minutes || 0),
            deals: Number(v.deals || 0),
            deltaPt: Number(v.deltaPt || 0),
          };
        }
      }
    }
    state = { byDate, byMember };
    fs.copyFileSync(p, p + ".bak.migrated");
    fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
    console.warn("[state] migrated old format -> { byDate, byMember }");
  } else {
    state = { byDate: {}, byMember: {} };
    fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
  }

  state.byDate = state.byDate || {};
  state.byMember = state.byMember || {};
  return { path: p, obj: state };
}
function saveState(pathStr: string, obj: StateShape) {
  fs.writeFileSync(pathStr, JSON.stringify(obj, null, 2), "utf-8");
}

// ===== レポート（Markdown） =====
function writeMarkdownReport(dateStr: string, rows: Array<{
  name: string;
  calls: number; minutes: number; deals: number;
  deltaPt: number; totalPt: number; title: string; streakDays: number;
}>) {
  const dir = path.resolve(process.cwd(), "reports");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${dateStr}.md`);
  const lines: string[] = [];
  lines.push(`# 日次レポート ${dateStr}`);
  lines.push("");
  lines.push("| メンバー | 架電 | 通話(分) | 成約 | 付与pt | 累計pt | 称号 | 連続日数 |");
  lines.push("|---|---:|---:|---:|---:|---:|---|---:|");
  for (const r of rows) {
    lines.push(`| ${r.name} | ${r.calls} | ${r.minutes} | ${r.deals} | ${r.deltaPt} | ${r.totalPt} | ${r.title} | ${r.streakDays} |`);
  }
  fs.writeFileSync(p, lines.join("\n"), "utf-8");
  console.log(`[report] generated: reports/${dateStr}.md`);
}

// ===== メイン処理 =====
export async function run(dateISO?: string, options?: { dryRun?: boolean; makeReport?: boolean }) {
  const schedule = loadYaml<any>("config/schedule.yml");
  const goals = loadYaml<any>("config/goals.yml");
  const tzName = schedule?.timezone || "Asia/Tokyo";
  const today = (dateISO ? dayjs(dateISO) : dayjs()).tz(tzName);
  const todayStr = today.format("YYYY-MM-DD");

  const members = loadMembers();
  const { path: statePath, obj: state } = loadState();
  state.byDate[todayStr] = state.byDate[todayStr] || {};

  console.log(`[orchestrator] date=${todayStr} tz=${tzName} members=${members.length} dryRun=${!!options?.dryRun}`);

  // KPI取得（MOCK_MODE=true ならダミー数値）
  const statsByOwner = await fetchDailyCallStats(todayStr, members);

  const reportRows: Array<{
    name: string; calls: number; minutes: number; deals: number;
    deltaPt: number; totalPt: number; title: string; streakDays: number;
  }> = [];

  for (const m of members) {
    // deals が未提供でも 0 扱いに正規化
    const raw = (statsByOwner[m.hubspotOwnerId] || { calls: 0, minutes: 0 }) as Stat;
    const s: Stat = { calls: raw.calls || 0, minutes: raw.minutes || 0, deals: raw.deals ?? 0 };

    const dailyPt = calcDailyPoints(s, goals);

    // 既存ステート
    const ms: MemberState = state.byMember[m.hubspotOwnerId] || { totalPt: 0, streakDays: 0 };

    // ストリーク更新
    const yesterday = today.clone().subtract(1, "day").format("YYYY-MM-DD");
    const achieved = judgeStreakAchieve(s, goals);
    if (achieved) {
      if (ms.lastDate === yesterday) ms.streakDays += 1;
      else ms.streakDays = 1;
      ms.lastDate = todayStr;
    } else {
      ms.streakDays = 0;
      ms.lastDate = todayStr;
    }
    const bonusPt = streakBonus(ms.streakDays, goals);
    const deltaPt = dailyPt + (bonusPt || 0);
    const newTotal = ms.totalPt + deltaPt;

    // 称号判定
    const { title, remainPt } = pickTitle(newTotal, goals);
    const rankedUp = title !== (ms.lastTitle || "");

    // バッジ
    const badges = checkBadges(s, goals);

    // 公告（今はコンソール出力）
    const msgs = buildAnnouncements({
      name: m.name,
      stats: s,
      deltaPt,
      totalPt: newTotal,
      newTitle: title,
      remainPt,
      badges,
      streakDays: ms.streakDays,
      streakBonusPt: bonusPt
    }, goals);
    if (rankedUp) {
      const temp = goals.announce?.template?.rankup || "RANKUP {name} {title}";
      msgs.unshift(
        temp.replace("{name}", m.name)
          .replace("{title}", title)
          .replace("{total_pt}", String(newTotal))
          .replace("{remain_pt}", String(remainPt))
      );
    }
    for (const line of msgs) console.log(line);

    // DRY RUN でなければ state 反映
    if (!options?.dryRun) {
      ms.totalPt = newTotal;
      ms.lastTitle = title;
      state.byDate[todayStr][m.hubspotOwnerId] = {
        calls: Number(s.calls || 0),
        minutes: Number(s.minutes || 0),
        deals: Number(s.deals || 0),
        deltaPt
      };
      state.byMember[m.hubspotOwnerId] = ms;
    }

    reportRows.push({
      name: m.name,
      calls: Number(s.calls || 0),
      minutes: Number(s.minutes || 0),
      deals: Number(s.deals || 0),
      deltaPt,
      totalPt: !options?.dryRun ? ms.totalPt : newTotal,
      title,
      streakDays: ms.streakDays
    });
  }

  if (!options?.dryRun) saveState(statePath, state);
  if (options?.makeReport) writeMarkdownReport(todayStr, reportRows);

  console.log("[orchestrator] done");
}

// ===== CLIオプション =====
// --date=YYYY-MM-DD   任意日付で実行（未指定なら“今日”）
// --dry-run           state.json を書き換えない（確認用）
// --report            reports/YYYY-MM-DD.md を生成
if (require.main === module) {
  const argv = process.argv.slice(2);
  const dateArg = argv.find(a => a.startsWith("--date="))?.split("=")[1];
  const dryRun = argv.includes("--dry-run");
  const makeReport = argv.includes("--report");

  run(dateArg, { dryRun, makeReport }).catch((e) => { console.error(e); process.exit(1); });
}
