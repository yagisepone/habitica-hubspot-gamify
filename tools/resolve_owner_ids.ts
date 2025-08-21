import fs from "fs";
import path from "path";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

type CsvRow = {
  name: string;
  email: string;
  hubspotOwnerId?: string;
  habiticaUserId?: string;
  habiticaApiToken?: string;
  active?: string;
};

type MemberJson = {
  name: string;
  email: string;
  hubspotOwnerId: string;
  habiticaUserId?: string;
  habiticaApiToken?: string;
  active: boolean;
};

const CSV = path.resolve(process.cwd(), "config/members.csv");
const OUT_JSON = path.resolve(process.cwd(), "config/members.json");
const REPORTS_DIR = path.resolve(process.cwd(), "reports");

const TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((s) => s.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((s) => s.trim());
    const row: any = {};
    headers.forEach((h, i) => (row[h] = cols[i] ?? ""));
    return row as CsvRow;
  });
}

async function fetchOwners(token: string) {
  const owners: { id: string; email?: string }[] = [];
  let after: string | undefined;
  while (true) {
    const url = new URL("https://api.hubapi.com/crm/v3/owners/");
    url.searchParams.set("archived", "false");
    if (after) url.searchParams.set("after", after);
    const res = await axios.get(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const results = res.data.results ?? [];
    for (const o of results) {
      owners.push({ id: String(o.id), email: o.email || o.user?.email });
    }
    after = res.data.paging?.next?.after;
    if (!after) break;
  }
  return owners;
}

function writeReport(lines: string[]) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const file = path.join(REPORTS_DIR, `owner_resolve-${ts}.txt`);
  fs.writeFileSync(file, lines.join("\n"), "utf-8");
  console.log(`[report] ${file}`);
}

(async () => {
  if (!fs.existsSync(CSV)) die(`CSV not found: ${CSV}`);
  const csvText = fs.readFileSync(CSV, "utf-8");
  const rows = parseCsv(csvText);

  // 入力チェック
  const seen = new Set<string>();
  const report: string[] = [];
  let hasErr = false;
  rows.forEach((r, i) => {
    if (!r.name) { report.push(`[ERR] row ${i + 2}: name required`); hasErr = true; }
    if (!r.email) { report.push(`[ERR] row ${i + 2}: email required`); hasErr = true; }
    const key = (r.email || "").toLowerCase();
    if (key) {
      if (seen.has(key)) { report.push(`[ERR] row ${i + 2}: duplicate email ${r.email}`); hasErr = true; }
      seen.add(key);
    }
  });
  if (hasErr) { writeReport(report); process.exit(1); }

  if (!TOKEN) die("HUBSPOT_PRIVATE_APP_TOKEN is missing in env.");

  console.log("[hubspot] fetching owners…");
  const owners = await fetchOwners(TOKEN);
  const byEmail = new Map<string, string>();
  owners.forEach((o) => { if (o.email) byEmail.set(o.email.toLowerCase(), o.id); });
  console.log(`[hubspot] owners loaded: ${owners.length}`);

  const out: MemberJson[] = [];
  let unresolved = 0;

  for (const r of rows) {
    const emailKey = (r.email || "").toLowerCase();
    let ownerId =
      r.hubspotOwnerId && r.hubspotOwnerId !== "TBD" ? r.hubspotOwnerId : byEmail.get(emailKey);

    if (!ownerId) {
      ownerId = `TBD_${r.name}`;
      report.push(`[WARN] unresolved: ${r.name} (${r.email}) -> ${ownerId}`);
      unresolved++;
    } else {
      report.push(`[OK] ${r.name} (${r.email}) -> ownerId=${ownerId}`);
    }

    out.push({
      name: r.name,
      email: r.email,
      hubspotOwnerId: ownerId,
      habiticaUserId: r.habiticaUserId || undefined,
      habiticaApiToken: r.habiticaApiToken || undefined,
      active: String(r.active ?? "true").toLowerCase() !== "false",
    });
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2), "utf-8");
  report.push(`[DONE] wrote ${OUT_JSON}`);
  if (unresolved > 0) report.push(`[SUMMARY] unresolved=${unresolved}/${rows.length}`);
  writeReport(report);

  // 未解決があれば非ゼロ終了にしたい場合は下を有効化
  // if (unresolved > 0) process.exit(2);
})();
