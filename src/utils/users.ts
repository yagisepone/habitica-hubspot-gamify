import fs from "fs";
import yaml from "js-yaml";
import members from "../../config/members.json";
import type { HabiticaCred } from "../connectors/habitica";

type MemberCfg = {
  key?: string;
  name?: string;
  display_name?: string;
  hubspot_owner_id?: string;      // 文字列必須
  canonical_user_id?: string;     // 社内での一意キー（任意）
  habitica_user_id?: string;      // 任意
  habitica_api_token?: string;    // 任意
};

export function ownerName(ownerId?: string) {
  if (!ownerId) return "不明ユーザー";
  return (members as Record<string, string>)[String(ownerId)] ?? `Owner:${ownerId}`;
}

/** users.yml / members.json から各種インデックスを構築 */
export function buildUserLookup() {
  const y = yaml.load(fs.readFileSync("config/users.yml", "utf8")) as any;
  const list: MemberCfg[] = Array.isArray(y?.members) ? y.members : [];

  const byOwner: Record<string, MemberCfg> = {};
  const byCanonical: Record<string, MemberCfg> = {};

  for (const m of list) {
    const ownerId = m?.hubspot_owner_id ? String(m.hubspot_owner_id) : undefined;
    if (ownerId) byOwner[ownerId] = m;

    const canon = m?.canonical_user_id ? String(m.canonical_user_id) : undefined;
    if (canon) byCanonical[canon] = m;
  }

  return { byOwner, byCanonical, list };
}

/** ownerId（HubSpotのownerId）から Habitica 資格を解決。無ければ .env をフォールバック */
export function resolveHabiticaCredByOwner(ownerId: string): HabiticaCred | undefined {
  try {
    const y = yaml.load(fs.readFileSync("config/users.yml", "utf8")) as any;
    const m = (y?.members || []).find((x: any) => String(x.hubspot_owner_id) === String(ownerId));
    if (m?.habitica_user_id && m?.habitica_api_token) {
      return { userId: m.habitica_user_id, apiToken: m.habitica_api_token };
    }
  } catch { /* noop */ }

  if (process.env.HABITICA_USER_ID && process.env.HABITICA_API_TOKEN) {
    return { userId: process.env.HABITICA_USER_ID, apiToken: process.env.HABITICA_API_TOKEN };
  }
  return undefined;
}

/** canonical_user_id（日報で使う社内一意キー）から Habitica 資格を解決 */
export function resolveHabiticaCredByCanonical(canonicalId: string): HabiticaCred | undefined {
  try {
    const y = yaml.load(fs.readFileSync("config/users.yml", "utf8")) as any;
    const m = (y?.members || []).find((x: any) => String(x.canonical_user_id) === String(canonicalId));
    if (m?.habitica_user_id && m?.habitica_api_token) {
      return { userId: m.habitica_user_id, apiToken: m.habitica_api_token };
    }
  } catch { /* noop */ }

  if (process.env.HABITICA_USER_ID && process.env.HABITICA_API_TOKEN) {
    return { userId: process.env.HABITICA_USER_ID, apiToken: process.env.HABITICA_API_TOKEN };
  }
  return undefined;
}

/** 互換：id を ownerId or canonical として順に解決（古い呼び出し元対応用） */
export function resolveHabiticaCred(id: string): HabiticaCred | undefined {
  return resolveHabiticaCredByOwner(id) ?? resolveHabiticaCredByCanonical(id);
}
