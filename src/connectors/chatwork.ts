// src/connectors/chatwork.ts
// Chatwork v2 API: POST /rooms/{room_id}/messages
// Header: X-ChatWorkToken, Body: application/x-www-form-urlencoded (body=...)
import querystring from "querystring";

const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN || "";
const CHATWORK_ROOM_ID   = process.env.CHATWORK_ROOM_ID || "";

export async function sendChatworkMessage(
  text: string,
  roomId: string = CHATWORK_ROOM_ID,
  token: string = CHATWORK_API_TOKEN
): Promise<{ success: boolean; status: number; json?: any; error?: string }> {
  if (!token) return { success: false, status: 0, error: "CHATWORK_API_TOKEN missing" };
  if (!roomId) return { success: false, status: 0, error: "CHATWORK_ROOM_ID missing" };

  const res = await fetch(`https://api.chatwork.com/v2/rooms/${roomId}/messages`, {
    method: "POST",
    headers: {
      "X-ChatWorkToken": token,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: querystring.stringify({
      body: text,
    }),
  });

  const status = res.status;
  const json = await res.json().catch(() => undefined);
  return { success: status >= 200 && status < 300, status, json };
}
