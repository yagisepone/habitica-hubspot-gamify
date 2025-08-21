import fs from "fs";
import path from "path";
import yaml from "js-yaml";

/** 1日単位のKPI */
export type DailyStats = {
  calls: number;
  minutes: number;
  new_appoint?: number; // 新規アポ件数
  approval?: number;    // 承認件数
  sales?: number;       // 売上（円）
  daily_task?: number;  // 自己目標タスク完了数
  deals?: number;       // 互換用（旧フィールド）
};

export type Goals = any;

/** goals.yml を読み込む */
export function loadGoals(): Goals {
  const p = path.resolve(process.cwd(), "config/goals.yml");
  return yaml.load(fs.readFileSync(p, "utf-8")) as any;
}

/** 1日のポイント計算（goals.yml のスキーマに準拠） */
export function calcDailyPoints(stats: DailyStats, goals: Goals) {
  const cfg = goals?.points || {};

  const callsPt   = (cfg.calls?.pt_per_unit ?? 0) * Math.max(0, stats.calls ?? 0);
  // minutes は 5分ブロック換算（pt_per_5min）。互換のため pt_per_unit があればそれを優先。
  const minutesBlock = Math.floor(Math.max(0, stats.minutes ?? 0) / 5);
  const minutesPt = cfg.minutes?.pt_per_unit != null
    ? (cfg.minutes.pt_per_unit ?? 0) * Math.max(0, stats.minutes ?? 0)
    : (cfg.minutes?.pt_per_5min ?? 0) * minutesBlock;

  const apptPt    = (cfg.new_appoint?.pt_per_unit ?? 0) * Math.max(0, stats.new_appoint ?? 0);
  const apprPt    = (cfg.approval?.pt_per_unit ?? 0)   * Math.max(0, stats.approval ?? 0);
  const salesTimes = Math.floor(Math.max(0, stats.sales ?? 0) / 100000);
  const salesPt   = (cfg.sales?.pt_per_100k_jpy ?? 0)  * salesTimes;
  const taskPt    = (cfg.daily_task?.pt_per_unit ?? 0) * Math.max(0, stats.daily_task ?? 0);

  // 旧構成（deals）への互換
  const dealsPt   = (cfg.deals?.pt_per_unit ?? 0) * Math.max(0, stats.deals ?? 0);

  const total = callsPt + minutesPt + apptPt + apprPt + salesPt + taskPt + dealsPt;
  return Math.max(0, Math.round(total));
}

/** 称号の決定（累計ポイント） */
export function pickTitle(totalPt: number, goals: Goals) {
  const titles = (goals?.titles || []).slice().sort((a: any, b: any) => (a.min_total_pt ?? 0) - (b.min_total_pt ?? 0));
  let picked = titles[0]?.name || "初心者";
  for (const t of titles) {
    if (totalPt >= (t.min_total_pt ?? 0)) picked = t.name;
  }
  // 次の称号までの残り
  let remain = 0;
  for (const t of titles) {
    const th = t.min_total_pt ?? 0;
    if (totalPt < th) { remain = th - totalPt; break; }
  }
  return { title: picked, remainPt: remain };
}

/** バッジ付与（当日条件） */
export function checkBadges(stats: DailyStats, goals: Goals) {
  const res: string[] = [];
  for (const b of goals?.badges || []) {
    const cond = b.condition || {};
    let ok = true;
    if (cond.calls        != null) ok = ok && (stats.calls ?? 0)        >= cond.calls;
    if (cond.minutes      != null) ok = ok && (stats.minutes ?? 0)      >= cond.minutes;
    if (cond.new_appoint  != null) ok = ok && (stats.new_appoint ?? 0)  >= cond.new_appoint;
    if (cond.approval     != null) ok = ok && (stats.approval ?? 0)     >= cond.approval;
    if (cond.sales        != null) ok = ok && (stats.sales ?? 0)        >= cond.sales;
    if (cond.daily_task   != null) ok = ok && (stats.daily_task ?? 0)   >= cond.daily_task;
    if (cond.deals        != null) ok = ok && (stats.deals ?? 0)        >= cond.deals; // 互換
    if (ok) res.push(b.name || b.key);
  }
  return res;
}

/** 連続達成の判定（calls/minutes の最低ラインのいずれかを満たせば達成） */
export function judgeStreakAchieve(stats: DailyStats, goals: Goals) {
  const rule = goals?.streak?.achieve_rule || {};
  const callsOk   = rule.calls_min   ? (stats.calls ?? 0)   >= rule.calls_min   : false;
  const minutesOk = rule.minutes_min ? (stats.minutes ?? 0) >= rule.minutes_min : false;
  return callsOk || minutesOk;
}

/** 連続達成ボーナス */
export function streakBonus(days: number, goals: Goals) {
  if (!goals?.streak?.enabled) return 0;
  let bonus = 0;
  for (const th of goals?.streak?.bonus?.thresholds || []) {
    if (days >= (th.days ?? 0)) bonus = Math.max(bonus, th.extra_pt ?? 0);
  }
  return bonus;
}

/** 通知文の生成（Chatwork 等に流用） */
export function buildAnnouncements(params: {
  name: string;
  stats: DailyStats;
  deltaPt: number;
  totalPt: number;
  newTitle: string;
  remainPt: number;
  badges: string[];
  streakDays: number;
  streakBonusPt: number;
}, goals: Goals) {
  const t = goals?.announce?.template || {};
  const msgs: string[] = [];
  if (goals?.announce?.enabled) {
    msgs.push(
      (t.daily || "✅ {name} 本日 {calls}件 / {minutes}分 / {deals}件成約 → {delta_pt} pt（累計 {total_pt} pt）")
        .replace("{name}", params.name)
        .replace("{calls}", String(params.stats.calls ?? 0))
        .replace("{minutes}", String(params.stats.minutes ?? 0))
        .replace("{deals}", String(params.stats.deals ?? 0)) // 互換
        .replace("{delta_pt}", String(params.deltaPt))
        .replace("{total_pt}", String(params.totalPt))
    );
    if (params.remainPt > 0) {
      // rankup時に別テンプレを使う想定（t.rankup）
    }
    if (params.badges?.length) {
      for (const b of params.badges) {
        msgs.push((t.badge || "{name} バッジ獲得：{badge}")
          .replace("{name}", params.name)
          .replace("{badge}", b));
      }
    }
    if (params.streakBonusPt > 0) {
      msgs.push((t.streak || "{name} 連続達成 {days} 日（ボーナス +{bonus_pt} pt）")
        .replace("{name}", params.name)
        .replace("{days}", String(params.streakDays))
        .replace("{bonus_pt}", String(params.streakBonusPt)));
    }
  }
  return msgs;
}
