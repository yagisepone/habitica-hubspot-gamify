import "dotenv/config";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import dayjs from "dayjs";
import { addMakerAward, HabiticaCred } from "../connectors/habitica";
import { buildUserLookup } from "../utils/users";
import { sendChatworkMessage } from "../connectors/chatwork";

const goals = yaml.load(
  fs.readFileSync(path.resolve(process.cwd(), "config/goals.yml"), "utf-8")
) as any;

function readJsonl(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  return lines
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

export async function runDaily(targetDate?: string) {
  const tzDate = targetDate || dayjs().format("YYYY-MM-DD");
  const from = dayjs(tzDate).startOf("day"); // ローカルTZ (TZ=Asia/Tokyo)
  const to   = dayjs(tzDate).endOf("day");

  // プラグイン不要：数値で範囲比較（両端含む）
  const inRange = (iso: string | number | Date | null | undefined) => {
    if (!iso) return false;
    const t = dayjs(iso).valueOf();
    return t >= from.valueOf() && t <= to.valueOf();
  };

  const appts = readJsonl(path.resolve(process.cwd(), "data/events/hubspot_appointments.jsonl"))
    .filter((e) => e?.type === "new_appointment" && inRange(e.occurred_at));

  const approvals = readJsonl(path.resolve(process.cwd(), "data/events/approvals.jsonl"))
    .filter((e) => e?.type === "approval" && inRange(e.approved_at));

  const apptCount = appts.length;
  const approvalCount = approvals.length;
  const approvalRate = apptCount > 0 ? Math.round((approvalCount / apptCount) * 1000) / 10 : 0;

  // メーカー集計
  const makerCount: Record<string, number> = {};
  for (const a of approvals) {
    const key = String(a.maker || "不明");
    makerCount[key] = (makerCount[key] || 0) + 1;
  }
  const makers = Object.entries(makerCount).sort((a, b) => b[1] - a[1]);
  const topCount = makers[0]?.[1] ?? 0;
  const topMakers = makers.filter(([_, c]) => c === topCount).map(([m]) => m);

  // 受賞者に Habitica バッジ（MOCK_MODE=true なら外部に出ません）
  const { byCanonical } = buildUserLookup();
  const winners = approvals.filter((a) => topMakers.includes(String(a.maker || "")));
  for (const w of winners) {
    const u = byCanonical[w.canonical_user_id];
    if (!u) continue;
    const cred: HabiticaCred = { userId: u.habitica_user_id, apiToken: u.habitica_api_token };
    await addMakerAward(cred, 1);
  }

  const makersText = makers.map(([m, c]) => `${m}:${c}件`).join(" / ") || "承認なし";
  await sendChatworkMessage(
    `🏆 ${tzDate} のメーカー賞：${topMakers.join("・") || "該当なし"} / 承認率 ${approvalRate}%（承認 ${approvalCount} / アポ ${apptCount}）\n内訳: ${makersText}`
  );

  const report = [
    `# 日報 ${tzDate}`,
    ``,
    `- 承認率: **${approvalRate}%** （承認 ${approvalCount} / アポ ${apptCount}）`,
    `- メーカー内訳: ${makersText || "-"}`,
    `- メーカー賞: ${topMakers.join("・") || "該当なし"}`,
    ``,
    `## 承認者`,
    ...winners.map((w) => `- ${w.display_name}（${w.maker}） ¥${(w.amount_jpy || 0).toLocaleString()}`),
  ].join("\n");

  const out = path.resolve(process.cwd(), "reports", `${tzDate}.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, report, "utf-8");

  console.log(
    `[daily] ${tzDate} done. approvalRate=${approvalRate}% top=${topMakers.join(",") || "-"} report=${out}`
  );
}

if (require.main === module) {
  const idx = process.argv.indexOf("--date");
  const date = idx >= 0 ? process.argv[idx + 1] : undefined;
  runDaily(date).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
