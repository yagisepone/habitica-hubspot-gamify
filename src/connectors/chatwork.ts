import axios from "axios";

const CHATWORK_API_BASE = process.env.CHATWORK_API_BASE || "https://api.chatwork.com/v2";
const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN || "";
const CHATWORK_ROOM_ID = process.env.CHATWORK_ROOM_ID || "";

/** Chatworkの指定ルームへメッセージ送信 */
export async function sendChatworkMessage(message: string, roomId: string = CHATWORK_ROOM_ID) {
  if (!roomId || !CHATWORK_API_TOKEN) {
    console.warn("Chatwork API token または Room ID が未設定のため通知をスキップ:", message);
    return;
  }
  const headers = { "X-ChatWorkToken": CHATWORK_API_TOKEN };
  const payload = { body: message };
  try {
    await axios.post(`${CHATWORK_API_BASE}/rooms/${roomId}/messages`, payload, { headers });
  } catch (err) {
    console.error("Chatworkメッセージ送信失敗:", err);
  }
}
