import { HABITICA_MIN_INTERVAL_MS } from "./env.js";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
let _habQ: Promise<any> = Promise.resolve();

export function habEnqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = async () => { await sleep(HABITICA_MIN_INTERVAL_MS); return fn(); };
  _habQ = _habQ.then(next, next);
  return _habQ as Promise<T>;
}

export async function habSafe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await habEnqueue(fn); }
  catch (e: any) { console.error("[habitica] suppressed:", e?.message || e); return undefined; }
}
