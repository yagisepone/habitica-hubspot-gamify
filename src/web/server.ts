// server.ts
import express, { Request, Response, NextFunction } from "express";

// ====== 環境変数 =============================================================
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

const CALL_XP_PER_CALL = Number(process.env.CALL_XP_PER_CALL ?? 1);
const CALL_XP_PER_5MIN = Number(process.env.CALL_XP_PER_5MIN ?? 2);
const CALL_XP_UNIT_MS = Number(process.env.CALL_XP_UNIT_MS ?? 300000); // 5分
const CALL_TOTALIZE_5MIN = Number(process.env.CALL_TOTALIZE_5MIN ?? 0); // 0固定（累計方式は使わない）

// ====== 既存コネクタの動的ロード（あれば使用） ==============================
let habiticaConn: any = null;
let chatworkConn: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  habiticaConn = require("../connectors/habitica.js");
} catch (_) {
  /* noop */
}
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  chatworkConn = require("../connectors/chatwork.js");
} catch (_) {
  /* noop */
}

// ====== ユーティリティ =======================================================
function bearerOk(req: Request): boolean {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return !!AUTH_TOKEN && token === AUTH_TOKEN;
}

// 任意認証（Authorization が来ていれば検証。なければ通す）
function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (auth) {
    if (!bearerOk(req)) {
      return _res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }
  next();
}

// 必須認証（管理系や手動テスト用）
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!bearerOk(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// ====== Habitica 連携（メール→ユーザ特定 & XP付与） =========================
// 既存コネクタ優先。なければ DRY ログ（実際の付与は行わない）
async function awardXPByEmail(email: string, amount: number, note?: string) {
  if (!email) throw new Error("empty_email");
  if (habiticaConn) {
    if (typeof habiticaConn.awardXPByEmail === "function") {
      await habiticaConn.awardXPByEmail(email, amount, note);
      return;
    }
    if (typeof habiticaConn.addXP === "function") {
      await habiticaConn.addXP(email, amount, note);
      return;
    }
    if (typeof habiticaConn.giveXp === "function") {
      await habiticaConn.giveXp(email, amount, note);
      return;
    }
  }
  console.log(`[dry][habitica] award ${amount}XP to ${email} ${note ? "(" + note + ")" : ""}`);
}

// （任意）Chatwork 通知
async function notifyChatwork(text: string) {
  try {
    if (chatworkConn && typeof chatworkConn.post === "function") {
      await chatworkConn.post(text);
      return;
    }
  } catch (e) {
    console.warn("[chatwork] notify failed:", (e as Error).message);
  }
  // ない場合はログのみ
  console.log("[chatwork] " + text);
}

// ====== 時間計測：Zoom から必要情報抽出 =====================================
// - 会話時間 talk_time(秒) を最優先。なければ start/end 差分（保持含む可能性）
// - 1コール上限 3時間(=10,800,000ms)
// - 返却: { callId, dir, email, zid, durMs, endedAt }
export function pickZoomInfo(body: any): {
  callId: string;
  dir: "outbound" | "inbound" | "unknown";
  email?: string;
  zid?: string;
  durMs: number;
  endedAt: number;
} {
  const b = (body?.payload ?? body) ?? {};
  const obj = b.object ?? b.call ?? b;

  const callId: string =
    obj.call_id ?? obj.session_id ?? obj.id ?? b.call_id ?? b.id ?? "unknown";

  const rawDir: string =
    obj.direction ?? obj.call_direction ?? b.direction ?? "";
  const low = String(rawDir).toLowerCase();
  const dir: "outbound" | "inbound" | "unknown" =
    low === "outbound" ? "outbound" : low === "inbound" ? "inbound" : "unknown";

  const email: string | undefined =
    obj.user_email ?? obj.caller_email ?? obj.owner_email ??
    b.user_email ?? b.caller_email ?? b.owner_email;

  const zid: string | undefined =
    obj.user_id ?? obj.owner_id ?? obj.account_id ?? b.user_id ?? b.owner_id;

  const talkSecRaw =
    obj.talk_time ?? obj.talkTime ?? b.talk_time ?? b.talkTime;

  const endIso =
    obj.end_time ?? obj.call_end_time ?? obj.ended_at ??
    b.end_time ?? b.call_end_time ?? b.ended_at;

  const startIso =
    obj.start_time ?? obj.call_start_time ?? obj.started_at ??
    b.start_time ?? b.call_start_time ?? b.started_at;

  let durMs = 0;
  if (typeof talkSecRaw === "number" && isFinite(talkSecRaw)) {
    durMs = Math.max(0, Math.floor(talkSecRaw * 1000)); // 会話時間(秒)→ms
  } else if (endIso && startIso) {
    const start = Date.parse(startIso);
    const end = Date.parse(endIso);
    if (isFinite(start) && isFinite(end)) {
      durMs = Math.max(0, end - start); // 予備：全体差分
    }
  }

  const MAX_MS = 3 * 60 * 60 * 1000; // 10,800,000ms
  if (durMs > MAX_MS) durMs = MAX_MS;

  const endedAt = endIso ? Date.parse(endIso) : Date.now();
  return { callId, dir, email, zid, durMs, endedAt };
}

// ====== XP計算：1コール +1XP、5分ごと +2XP（既定） ==========================
async function awardXpForCallDuration(who: string, durMs: number) {
  // ！！デバッグログ（仕様指定の1行） ← 関数冒頭！！
  console.log(
    `[call] calc who=${who} durMs=${durMs} unit=${Number(process.env.CALL_XP_UNIT_MS ?? 300000)} per5=${Number(process.env.CALL_XP_PER_5MIN ?? 2)}`
  );

  if (!who) return;

  // 5分ごとの加点
  const units = Math.floor(durMs / CALL_XP_UNIT_MS);
  const bonus = units * CALL_XP_PER_5MIN;

  if (bonus > 0) {
    await awardXPByEmail(who, bonus, `(5分加点) +${bonus}XP`);
    console.log(`(5分加点) +${bonus}XP`);
  }

  // 毎コール +1XP
  if (CALL_XP_PER_CALL > 0) {
    await awardXPByEmail(who, CALL_XP_PER_CALL, "(+call) +" + CALL_XP_PER_CALL + "XP");
    console.log(`(+call) +${CALL_XP_PER_CALL}XP`);
  }
}

// ====== Express アプリ =======================================================
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "sales-gamify", time: new Date().toISOString() });
});

// ---- 管理：Habitica Webhook 自動登録（既存コネクタがあれば使用） -----------
app.post("/admin/habitica/setup-webhooks", requireAuth, async (req, res) => {
  try {
    const base = PUBLIC_BASE_URL || req.body?.base || req.headers["x-public-base-url"] || "";
    if (!base) {
      return res.status(400).json({ ok: false, error: "PUBLIC_BASE_URL missing" });
    }

    let registered = false;
    if (habiticaConn) {
      if (typeof habiticaConn.setupWebhooks === "function") {
        await habiticaConn.setupWebhooks(String(base));
        registered = true;
      } else if (typeof habiticaConn.ensureWebhooks === "function") {
        await habiticaConn.ensureWebhooks(String(base));
        registered = true;
      } else if (typeof habiticaConn.registerWebhooks === "function") {
        await habiticaConn.registerWebhooks(String(base));
        registered = true;
      }
    }

    res.json({
      ok: true,
      action: "habitica-webhook-setup",
      base: String(base),
      events: ["taskActivity"],
      registered
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ---- Habitica Webhook 受信（taskActivity → 日報 +10XP） --------------------
// ・Authorizationヘッダがあれば検証、なければ受け入れ（外部Webhook想定）
// ・task.text に「日報」を含む / 完了（todo, completed: true）を +10XP
app.post("/webhooks/habitica", optionalAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const type = body.type || body.event || "";
    const task = body.task || {};
    const user = body.user || {};
    const direction = body.direction || "";

    // タスク完了（To-Do）を検知
    const isTodo = (task.type || "").toLowerCase() === "todo";
    const completed = Boolean(task.completed);
    const text: string = String(task.text || "");
    const containsNichou = text.includes("日報");

    if ((type === "taskActivity" || type === "taskScored") && isTodo && completed && containsNichou) {
      // ユーザ特定：メールがあればメール、なければ user.id → コネクタ側に任せる
      const who = user.email || user.mail || user.username || user.id;
      const xp = 10;
      await awardXPByEmail(who, xp, "📝 日報ボーナス +10XP");
      await notifyChatwork(`📝 日報完了: ${who} に +${xp}XP`);
      return res.json({ ok: true, source: "habitica", event: "taskActivity", note: "📝 日報ボーナス +10XP", awarded: xp });
    }

    res.json({ ok: true, source: "habitica", passthrough: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ---- Zoom Webhook 受信（通話終了ベース想定） --------------------------------
// ・Outbound のみ対象
// ・talk_time(秒) 優先、fallback: start/end 差分
// ・上限3時間で丸め、5分ごとXPとコールXPを付与
app.post("/webhooks/zoom", optionalAuth, async (req, res) => {
  try {
    const info = pickZoomInfo(req.body);

    if (info.dir !== "outbound") {
      console.log(`[zoom] ignore non-outbound callId=${info.callId} dir=${info.dir}`);
      return res.json({ ok: true, ignored: "non-outbound" });
    }

    const who = info.email || info.zid || ""; // メール優先
    await awardXpForCallDuration(who, info.durMs);

    res.json({
      ok: true,
      source: "zoom",
      callId: info.callId,
      who,
      durMs: info.durMs,
      endedAt: info.endedAt
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ---- サーバ起動 -------------------------------------------------------------
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`[web] sales-gamify server listening on :${PORT}`);
  if (!AUTH_TOKEN) console.warn("[warn] AUTH_TOKEN is empty");
  if (!PUBLIC_BASE_URL) console.warn("[warn] PUBLIC_BASE_URL is empty (webhook auto-setup may fail)");
});
