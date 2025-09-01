// src/scheduler/cron.ts
import "dotenv/config";
import cron from "node-cron";
import { spawn } from "child_process";

// ---- 基本設定 ---------------------------------------------------------------
const TZ = process.env.TZ || "Asia/Tokyo";        // PM2 側にTZがなくても、ここでJST固定
const TODAY = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// 子プロセスを実行（ログを前置きしてそのまま吐く・終了コードで成否判定）
function run(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "pipe", shell: false });
    const tag = `${cmd} ${args.join(" ")}`;

    p.stdout.on("data", (d) => process.stdout.write(`[out] ${tag}\n${d}`));
    p.stderr.on("data", (d) => process.stderr.write(`[err] ${tag}\n${d}`));

    p.on("close", (code) => {
      if (code === 0) {
        console.log(`[ok ] ${tag}`);
        resolve();
      } else {
        console.error(`[ng ] ${tag} (exit=${code})`);
        reject(new Error(`${tag} exit=${code}`));
      }
    });
  });
}

// 重複起動防止（ジョブごとの簡易ロック）
const lock: Record<string, boolean> = {};
function schedule(spec: string, name: string, job: () => Promise<void>) {
  cron.schedule(
    spec,
    async () => {
      if (lock[name]) {
        console.warn(`[skip] ${name} already running`);
        return;
      }
      lock[name] = true;
      const startedAt = new Date().toISOString();
      console.log(`[run ] ${name} @ ${startedAt} TZ=${TZ}`);
      try {
        await job();
        console.log(`[done] ${name} @ ${new Date().toISOString()}`);
      } catch (e) {
        console.error(`[fail] ${name}:`, e);
      } finally {
        lock[name] = false;
      }
    },
    { timezone: TZ }
  );
}

// ---- スケジュール定義（JST） ------------------------------------------------
// 18:05  日報生成（Markdown出力・メーカー賞など）
schedule("5 18 * * *", "daily-report", async () => {
  await run("npx", ["ts-node", "src/orchestrator/daily.ts", "--date", TODAY()]);
});

// 18:10  Webhook/CSVで溜まったイベントを Habitica に付与（今回追加したやつ）
schedule("10 18 * * *", "award-from-events", async () => {
  await run("npx", ["ts-node", "src/scripts/award_from_events.ts"]);
});

// 18:12  状態ファイルの再集計（累積ポイント・任意メトリクス）
schedule("12 18 * * *", "state-from-events", async () => {
  await run("npx", ["ts-node", "src/scripts/state_from_events.ts", "--date", TODAY()]);
});

// 00:10  前日イベントのローテーション（任意・ある場合）
schedule("10 0 * * *", "rotate-events", async () => {
  await run("npx", ["ts-node", "src/scripts/rotate_events.ts"]);
});

// 09:00  目標タスクの配布（任意で使う場合。スクリプトがあればONに）
/*
schedule("0 9 * * *", "distribute-goals", async () => {
  await run("npx", ["ts-node", "src/scripts/distribute_goals.ts"]);
});
*/

// 起動ログ
console.log(`[boot] gamify-cron started. TZ=${TZ} (node-cron)`);
