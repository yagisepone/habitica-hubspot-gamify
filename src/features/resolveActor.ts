// src/features/resolveActor.ts
// 担当者表示名と担当者メールを決定するユーティリティ。
// HubSpot / Workflow / Zoom いずれのイベントでも利用される前提。

import { safeParse, normSpace, parseHubSpotSourceUserId } from "../lib/utils.js";
import { HUBSPOT_USER_MAP_JSON } from "../lib/env.js";
import { MAIL2NAME } from "../lib/maps.js";

export function resolveActor(
  ev: { source: "v3" | "workflow" | "zoom"; raw?: any }
): { name: string; email?: string } {
  const raw = ev.raw || {};

  /* 1) email の推定（あれば最優先） */
  let email: string | undefined =
    raw.actorEmail ||
    raw.ownerEmail ||
    raw.userEmail ||
    raw?.owner?.email ||
    raw?.properties?.owner_email ||
    raw?.properties?.hubspot_owner_email ||
    raw?.userEmail;

  /* 2) HubSpot の user/owner の ID 候補を総当たり + sourceId(userId:xxxx) パターン */
  const ownerId =
    raw?.properties?.hubspot_owner_id ??
    raw?.hubspot_owner_id ??
    parseHubSpotSourceUserId(raw) ??
    raw?.ownerId ??
    raw?.associatedOwnerId ??
    raw?.owner?.id ??
    raw?.hsUserId ??
    raw?.createdById ??
    raw?.actorId ??
    raw?.userId;

  /* 3) 環境変数のマップで補完（HUBSPOT_USER_MAP_JSON は { [id]: {name,email} }） */
  const hsMap = safeParse<Record<string, { name?: string; email?: string }>>(HUBSPOT_USER_MAP_JSON) || undefined;
  const hs = ownerId != null ? hsMap?.[String(ownerId)] : undefined;

  const finalEmail = (email || hs?.email || "").toLowerCase() || undefined;

  /* 4) 表示名の最終決定ルール
        - メール → MAIL2NAME の対応表
        - HUBSPOT_USER_MAP_JSON の name
        - メールのローカル部
        - デフォルト "担当者"
  */
  const display =
    (finalEmail && MAIL2NAME[finalEmail]) ||
    (hs?.name && normSpace(hs.name)) ||
    (finalEmail ? String(finalEmail).split("@")[0] : undefined) ||
    "担当者";

  return { name: display, email: finalEmail };
}
