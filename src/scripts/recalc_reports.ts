import "dotenv/config";
import dayjs from "dayjs";
import { runDaily } from "../orchestrator/daily";

(async () => {
  const start = process.argv[2];
  const end   = process.argv[3];
  if (!start || !end) {
    console.log("Usage: ts-node src/scripts/recalc_reports.ts 2025-08-01 2025-08-25");
    process.exit(1);
  }
  let d = dayjs(start);
  const last = dayjs(end);
  while (d.isSame(last) || d.isBefore(last)) {
    await runDaily(d.format("YYYY-MM-DD"));
    d = d.add(1, "day");
  }
  console.log("[recalc] done");
})();
