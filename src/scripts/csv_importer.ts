import "dotenv/config";
import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import yaml from "js-yaml";
import dayjs from "dayjs";

import { buildUserLookup } from "../utils/users";
import { addApproval, addSales, HabiticaCred } from "../connectors/habitica";
import { sendChatworkMessage } from "../connectors/chatwork";
import { isProcessed, markProcessed } from "../utils/idempotency";

const goals = yaml.load(
  fs.readFileSync(path.resolve("config/goals.yml"), "utf-8")
) as any;

function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }
function appendJsonl(filePath: string, obj: any) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf-8");
}
function normalizeEncoding(enc?: string): BufferEncoding {
  if (!enc) return "utf8";
  const v = enc.toLowerCase();
  return (v === "utf-8" ? "utf8" : v) as BufferEncoding;
}

async function processCsv(filePath: string) {
  const encoding = normalizeEncoding(process.env.CSV_ENCODING);
  const content = fs.readFileSync(filePath, { encoding });
  const records: any[] = parse(content, { columns: true, skip_empty_lines: true });

  const { byCanonical } = buildUserLookup();

  for (const row of records) {
    const apoId   = String(row["apo_id"] ?? row["APO_ID"] ?? "");
    const userId  = String(row["user_id"] ?? row["USER_ID"] ?? "");
    const status  = String(row["承認可否"] ?? row["status"] ?? "");
    const amount  = Number(row["売上金額"] ?? row["amount_jpy"] ?? 0);
    const maker   = String(row["メーカー名"] ?? row["maker"] ?? "");
    const dateStr = String(row["承認日"] ?? row["approved_at"] ?? "");

    if (!apoId) continue;
    if (isProcessed(apoId)) continue;
    markProcessed(apoId);

    const user = byCanonical[userId];
    if (!user) { console.warn("[CSV] unknown user_id:", userId); continue; }

    // Habitica 連携は「ID/Token 両方あるときだけ」実施
    const hasHabitica = Boolean(user.habitica_user_id && user.habitica_api_token);

    if (status === "承認" || status.toLowerCase() === "approved") {
      if (hasHabitica) {
        const cred: HabiticaCred = { userId: user.habitica_user_id!, apiToken: user.habitica_api_token! };
        await addApproval(cred, 1);
        if (amount > 0) await addSales(cred, amount);
      } else {
        console.warn(`[CSV] Habitica cred missing for ${user.display_name} (skip Habitica award)`);
      }

      const xpApproval = goals?.points?.approval?.pt_per_unit ?? 30;
      const xpSales    = (goals?.points?.sales?.pt_per_100k_jpy ?? 50) * Math.floor(amount / 100000);
      const totalXp    = xpApproval + xpSales;

      await sendChatworkMessage(`✅ ${user.display_name} のアポが承認！ 売上 ¥${amount.toLocaleString()} (+${totalXp}XP)`);

      appendJsonl(
        path.resolve("data/events/approvals.jsonl"),
        {
          type: "approval",
          canonical_user_id: user.canonical_user_id,
          display_name: user.display_name,
          amount_jpy: amount,
          maker,
          approved_at: dayjs(dateStr || undefined).isValid()
            ? dayjs(dateStr).startOf("day").toISOString()
            : dayjs().startOf("day").toISOString(),
          apo_id: apoId
        }
      );
    }
  }
}

(async () => {
  const dir = process.env.CSV_IMPORT_DIR || "./data/import";
  if (!fs.existsSync(dir)) { console.warn("[CSV] directory not found:", dir); return; }
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".csv"));
  for (const f of files) {
    const p = path.join(dir, f);
    console.log("[CSV] processing", p);
    await processCsv(p).catch(err => console.error(err));
  }
})();
