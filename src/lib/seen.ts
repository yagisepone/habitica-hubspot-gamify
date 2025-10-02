import { DEDUPE_TTL_SEC } from "./env.js";

const seen = new Map<string, number>();

export function hasSeen(id?: any) {
  if (id == null) return false;
  const key = String(id);
  const now = Date.now();
  for (const [k, ts] of seen) { if (now - ts > DEDUPE_TTL_SEC * 1000) seen.delete(k); }
  return seen.has(key);
}
export function markSeen(id?: any) {
  if (id == null) return;
  seen.set(String(id), Date.now());
}
