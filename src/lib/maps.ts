import { safeParse, normSpace } from "./utils.js";
import { HABITICA_USERS_JSON, NAME_EMAIL_MAP_JSON, ZOOM_EMAIL_MAP_JSON } from "./env.js";

type HabiticaCred = { userId: string; apiToken: string };

function buildHabiticaMap(s: string) {
  const p = safeParse<Record<string, HabiticaCred>>(s) || {};
  const out: Record<string, HabiticaCred> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v?.userId && v?.apiToken) out[k.toLowerCase()] = { userId: String(v.userId), apiToken: String(v.apiToken) };
  }
  return out;
}
function buildNameEmailMap(s: string) {
  const p = safeParse<Record<string, string>>(s) || {};
  const out: Record<string, string> = {};
  for (const [n, e] of Object.entries(p)) {
    if (!n || !e) continue;
    out[normSpace(n)] = e.toLowerCase();
  }
  return out;
}
function buildZoomEmailMap(s: string) {
  const p = safeParse<Record<string, string>>(s) || {};
  const out: Record<string, string> = {};
  for (const [z, e] of Object.entries(p)) {
    if (!z || !e) continue;
    out[z] = e.toLowerCase();
  }
  return out;
}

export const HAB_MAP = buildHabiticaMap(HABITICA_USERS_JSON);
export const NAME2MAIL = buildNameEmailMap(NAME_EMAIL_MAP_JSON);
export const ZOOM_UID2MAIL = buildZoomEmailMap(ZOOM_EMAIL_MAP_JSON);

export const MAIL2NAME: Record<string, string> = {};
for (const [jp, m] of Object.entries(NAME2MAIL)) { MAIL2NAME[m] = jp; }

export const INTERNAL_EMAILS = new Set<string>(Object.keys(HAB_MAP));
export const INTERNAL_NAMES  = new Set<string>(Object.keys(NAME2MAIL).map(normSpace));

export function isInternal(name?: string, email?: string): boolean {
  const em = (email || "").toLowerCase().trim();
  const nm = normSpace(name);
  return (!!em && INTERNAL_EMAILS.has(em)) || (!!nm && INTERNAL_NAMES.has(nm));
}

export const getHabitica = (email?: string) => email ? HAB_MAP[email.toLowerCase()] : undefined;
