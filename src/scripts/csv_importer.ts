import fs from "fs";
import path from "path";
import csvParse from "csv-parse/sync";
import yaml from "js-yaml";
import { buildUserLookup } from "../utils/users";
import { addApproval, addSales, HabiticaCred } from "../connectors/habitica";
import { sendChatworkMessage } from "../connectors/chatwork";
import { isProcessed, markProcessed } from "../utils/idempotency";

const goals = yaml.load(fs.readFileSync(path.resolve(process.cwd(), "config/goals.yml"), "utf-8")) as any;

/** CSV 1枚を処理する */
async function processCsv(filePath: string) {
  const content = fs.readFileSync(filePath, process.env.CSV_ENCODING || "utf-8");
  const records = csvParse.parse(content, { columns: true, skip_empty_lines: true });
  const { byCanonical } = buildUserLookup();

  for (const row of records) {
    const apoId    = row["apo_id"];
    const userId   = row["user_id"];
    const status   = row["承認可否"];
    const amount   = Number(row["売上金額"] || 0);
    const maker    = row["メーカー名"];
    const date     = row["承認日"];
    if (isProcessed(apoId)) continue;
    markProcessed(apoId);

    const user = byCanonical[userId];
    if (!user) {
      console.warn("CSVに未知のuser_id:", userId);
      continue;
    }
    if (status === "承認") {
      const cred: HabiticaCred = { userId: user.habitica_user_id, apiToken: user.habitica_api_token };
      await addApproval(cred, 1);
      const salesTimes = Math.floor(amount / 100000);
      if (salesTimes > 0) await addSales(cred, amount);
      const xpApproval = goals.points?.approval?.pt_per_unit     ?? 30;
      const xpSales    = (goals.points?.sales?.pt_per_100k_jpy ?? 50) * salesTimes;
      const totalXp    = xpApproval + xpSales;
      const msg = `✅ ${user.display_name} のアポが承認！ 売上 ¥${amount.toLocaleString()} (+${totalXp}XP)`;
      await sendChatworkMessage(msg);
      // メーカー賞カウントは日次バッチで集計してください
    }
  }
}

/** ディレクトリ内のCSVをすべて処理 */
(async () => {
  const dir = process.env.CSV_IMPORT_DIR || "./data/import";
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".csv"));
  for (const f of files) {
    const filePath = path.join(dir, f);
    await processCsv(filePath).catch(err => console.error(err));
  }
})();
