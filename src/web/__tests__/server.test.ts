/**
 * サーバーテスト（Basic認証 on/off、最小データのHTML生成）
 */
import fs from "fs";
import path from "path";
import request from "supertest";

const DATA_DIR = path.resolve(process.cwd(), "data");
const CONFIG_DIR = path.resolve(process.cwd(), "config");
const REPORTS_DIR = path.resolve(process.cwd(), "reports");

function writeFixtureFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const today = "2025-08-01";
  const state = {
    byDate: {
      [today]: {
        "owner-123": { calls: 10, minutes: 30, deals: 1, deltaPt: 50 }
      }
    },
    byMember: {
      "owner-123": { totalPt: 500, streakDays: 3, lastDate: today, lastTitle: "商談ファイター" }
    }
  };
  fs.writeFileSync(path.join(DATA_DIR, "state.json"), JSON.stringify(state), "utf-8");

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const members = [{ name: "福田", hubspotOwnerId: "owner-123" }];
  fs.writeFileSync(path.join(CONFIG_DIR, "members.json"), JSON.stringify(members), "utf-8");

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORTS_DIR, `${today}.md`), "# dummy report", "utf-8");

  return { today };
}

// 指定の環境変数で app を再ロード
async function loadServerWithEnv(env: Record<string, string | undefined>) {
  // まず BASIC_* をクリア
  delete (process.env as any).BASIC_USER;
  delete (process.env as any).BASIC_PASS;

  // デフォは Basic 認証を無効化してテスト
  (process.env as any).BASIC_AUTH_DISABLE = "true";
  (process.env as any).NODE_ENV = "test";

  // 上書き
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete (process.env as any)[k];
    else (process.env as any)[k] = v;
  }

  jest.resetModules(); // dotenv/config を含め再評価
  const mod = await import("../../web/server");
  return mod.app as import("express").Express;
}

describe("server", () => {
  const { today } = writeFixtureFiles();

  test("health returns ok", async () => {
    const app = await loadServerWithEnv({});
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("GET /api/state returns JSON state", async () => {
    const app = await loadServerWithEnv({});
    const res = await request(app).get("/api/state");
    expect(res.status).toBe(200);
    expect(res.body.byDate).toBeDefined();
    expect(res.body.byMember).toBeDefined();
  });

  test("GET / (no auth) renders HTML when basic is disabled", async () => {
    const app = await loadServerWithEnv({});
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("営業ゲーミフィケーション ダッシュボード");
    expect(res.text).toContain("<table>");
  });

  test("GET / with Basic auth enabled requires credentials", async () => {
    // ★ Basic有効化：無効フラグを外し、NODE_ENV を 'development' にして認証ON
    const app = await loadServerWithEnv({
      BASIC_AUTH_DISABLE: undefined,
      NODE_ENV: "development",
      BASIC_USER: "dev",
      BASIC_PASS: "devpass"
    });

    const res401 = await request(app).get("/");
    expect(res401.status).toBe(401);

    const basic = Buffer.from("dev:devpass").toString("base64");
    const res200 = await request(app).get("/").set("Authorization", `Basic ${basic}`);
    expect(res200.status).toBe(200);
    expect(res200.text).toContain("営業ゲーミフィケーション ダッシュボード");
  });

  test("GET /day?d=2025-08-01 renders the specified date", async () => {
    const app = await loadServerWithEnv({});
    const res = await request(app).get("/day").query({ d: today });
    expect(res.status).toBe(200);
    expect(res.text).toContain(`Dashboard ${today}`);
  });
});
