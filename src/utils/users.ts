import fs from "fs";
import path from "path";
import yaml from "js-yaml";

interface UserEntry {
  canonical_user_id: string;
  display_name: string;
  zoom_user_id?: string;
  hubspot_owner_id?: string;
  habitica_user_id: string;
  habitica_api_token: string;
  chatwork_account_id?: string;
  chatwork_mention?: string;
}

/** users.yml を読み込んで配列で返す */
export function loadUsers(): UserEntry[] {
  const p = path.resolve(process.cwd(), "config/users.yml");
  const raw = fs.readFileSync(p, "utf-8");
  return yaml.load(raw) as UserEntry[];
}

/** 各サービスIDからユーザーを引けるようマップを生成 */
export function buildUserLookup() {
  const users = loadUsers();
  const byZoom: Record<string, UserEntry> = {};
  const byHubSpot: Record<string, UserEntry> = {};
  const byCanonical: Record<string, UserEntry> = {};
  for (const u of users) {
    byCanonical[u.canonical_user_id] = u;
    if (u.zoom_user_id) byZoom[u.zoom_user_id] = u;
    if (u.hubspot_owner_id) byHubSpot[String(u.hubspot_owner_id)] = u;
  }
  return { byZoom, byHubSpot, byCanonical };
}
