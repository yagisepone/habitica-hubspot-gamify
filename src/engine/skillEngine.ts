import fs from "fs";
import path from "path";
import yaml from "js-yaml";

type DailyStats = { calls: number; minutes: number; deals?: number };
type Goals = any;

function loadGoals(): Goals {
  const p = path.resolve(process.cwd(), "config/goals.yml");
  return yaml.load(fs.readFileSync(p, "utf-8")) as any;
}

export function calcDailyPoints(stats: DailyStats, goals: Goals) {
  const ptCfg = goals.points || {};
  const callsPt = (ptCfg.calls?.pt_per_unit ?? 0) * (stats.calls ?? 0);
  const minutesPt = (ptCfg.minutes?.pt_per_unit ?? 0) * (stats.minutes ?? 0);
  const dealsPt = (ptCfg.deals?.pt_per_unit ?? 0) * (stats.deals ?? 0);
  return Math.max(0, Math.round(callsPt + minutesPt + dealsPt));
}

export function pickTitle(totalPt: number, goals: Goals) {
  const titles = (goals.titles || []).sort((a: any, b: any) => a.min_total_pt - b.min_total_pt);
  let picked = titles[0]?.name || "初心者";
  for (const t of titles) {
    if (totalPt >= (t.min_total_pt ?? 0)) picked = t.name;
  }
  // 次の称号まで残り
  let remain = 0;
  for (const t of titles) {
    if (totalPt < (t.min_total_pt ?? 0)) { remain = t.min_total_pt - totalPt; break; }
  }
  return { title: picked, remainPt: remain };
}

export function checkBadges(stats: DailyStats, goals: Goals) {
  const res: string[] = [];
  for (const b of goals.badges || []) {
    const cond = b.condition || {};
    const okCalls = cond.calls ? (stats.calls ?? 0) >= cond.calls : true;
    const okMinutes = cond.minutes ? (stats.minutes ?? 0) >= cond.minutes : true;
    const okDeals = cond.deals ? (stats.deals ?? 0) >= cond.deals : true;
    if (okCalls && okMinutes && okDeals) res.push(b.name || b.key);
  }
  return res;
}

export function judgeStreakAchieve(stats: DailyStats, goals: Goals) {
  const rule = goals.streak?.achieve_rule || {};
  const callsOk = rule.calls_min ? (stats.calls ?? 0) >= rule.calls_min : false;
  const minutesOk = rule.minutes_min ? (stats.minutes ?? 0) >= rule.minutes_min : false;
  return callsOk || minutesOk;
}

export function streakBonus(days: number, goals: Goals) {
  if (!goals.streak?.enabled) return 0;
  let bonus = 0;
  for (const th of goals.streak?.bonus?.thresholds || []) {
    if (days >= th.days) bonus = Math.max(bonus, th.extra_pt ?? 0);
  }
  return bonus;
}

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
  const t = goals.announce?.template || {};
  const msgs: string[] = [];
  if (goals.announce?.enabled) {
    msgs.push(
      (t.daily || "{name} {delta_pt}").replace("{name}", params.name)
        .replace("{calls}", String(params.stats.calls ?? 0))
        .replace("{minutes}", String(params.stats.minutes ?? 0))
        .replace("{deals}", String(params.stats.deals ?? 0))
        .replace("{delta_pt}", String(params.deltaPt))
        .replace("{total_pt}", String(params.totalPt))
    );
    if (params.remainPt > 0) {
      // 次の称号まで表示はdaily文に含めても良いが、簡潔のため rankup時のみ。
    }
    if (params.badges?.length) {
      for (const b of params.badges) {
        msgs.push((t.badge || "{name} {badge}")
          .replace("{name}", params.name).replace("{badge}", b));
      }
    }
    if (params.streakBonusPt > 0) {
      msgs.push((t.streak || "{name} streak {days}")
        .replace("{name}", params.name)
        .replace("{days}", String(params.streakDays))
        .replace("{bonus_pt}", String(params.streakBonusPt)));
    }
  }
  return msgs;
}
