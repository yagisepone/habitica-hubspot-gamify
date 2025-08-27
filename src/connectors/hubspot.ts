// src/connectors/hubspot.ts
// 最小構成：Noteを作成。必要ならemailで連絡先検索→関連付け
const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";

async function hsFetch(url: string, init: RequestInit = {}) {
  if (!HUBSPOT_TOKEN) throw new Error("HUBSPOT_PRIVATE_APP_TOKEN missing");
  const headers = {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json",
    ...(init.headers || {}),
  };
  const res = await fetch(url, { ...init, headers });
  const json = await res.json().catch(() => undefined);
  if (!res.ok) {
    const msg = JSON.stringify(json);
    throw new Error(`HubSpot ${res.status}: ${msg}`);
  }
  return json;
}

/** Note作成（単体） */
export async function hsCreateNote(body: string) {
  return hsFetch("https://api.hubapi.com/crm/v3/objects/notes", {
    method: "POST",
    body: JSON.stringify({
      properties: { hs_note_body: body },
    }),
  });
}

/** email でコンタクト検索 → IDを返す（見つからなければ undefined） */
export async function hsFindContactIdByEmail(email: string): Promise<string | undefined> {
  const res = await hsFetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [
        { filters: [{ propertyName: "email", operator: "EQ", value: email }] },
      ],
      properties: ["email"],
      limit: 1,
    }),
  });
  const id = res?.results?.[0]?.id;
  return typeof id === "string" ? id : undefined;
}

/** Note を Contact に関連付け（Note作成後に実行） */
export async function hsAssociateNoteToContact(noteId: string, contactId: string) {
  // v3 association API（note_to_contact ラベル）
  const url = `https://api.hubapi.com/crm/v3/objects/notes/${noteId}/associations/contacts/${contactId}/note_to_contact`;
  return hsFetch(url, { method: "PUT" });
}

/** 便利ワンショット：Note作成→（あれば）emailの連絡先に紐付け */
export async function hsCreateNoteOptionallyAssociate(body: string, email?: string) {
  const note = await hsCreateNote(body);
  const noteId = note?.id;
  if (email && noteId) {
    const cid = await hsFindContactIdByEmail(email).catch(() => undefined);
    if (cid) {
      await hsAssociateNoteToContact(noteId, cid).catch(() => undefined);
    }
  }
  return note;
}
