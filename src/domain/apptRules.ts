// @ts-nocheck
// src/domain/apptRules.ts

import { APPOINTMENT_VALUES, APPOINTMENT_XP } from "../lib/env.js";
import * as labelsStore from "../store/labels.js";

// ---------- ユーティリティ ----------
const asStr = (v: unknown): string => "" + (v ?? "");
const lc = (v: unknown): string => asStr(v).toLowerCase();
const arr = (v: any): any[] =>
  Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);

// store/labels.js が同期でも非同期でも安全に読むラッパ
async function readObservedIds(tenant: string): Promise<string[]> {
  try {
    const fn = (labelsStore as any).getObservedLabelIds;
    const v = typeof fn === "function" ? await Promise.resolve(fn(tenant)) : (labelsStore as any).observedIds;
    return arr(v).map(asStr);
  } catch { return []; }
}
async function readObservedTitles(tenant: string): Promise<string[]> {
  try {
    const fn = (labelsStore as any).getObservedLabelTitles;
    const v = typeof fn === "function" ? await Promise.resolve(fn(tenant)) : (labelsStore as any).observedTitles;
    return arr(v).map(asStr);
  } catch { return []; }
}

/**
 * outcome（ラベルIDやタイトル）が「アポとして数える対象か」を判定。
 * テナント固有のラベルID/タイトルがあれば優先。無ければ ENV を使用。
 */
export async function isAppointmentOutcome(tenant: string, outcome: string): Promise<boolean> {
  const v = lc(outcome).trim();
  if (!v) return false;

  // テナント固有があれば優先
  try {
    const [ids, titles] = await Promise.all([
      readObservedIds(tenant),
      readObservedTitles(tenant),
    ]);
    if (ids.length || titles.length) {
      return ids.map(lc).includes(v) || titles.map(lc).includes(v);
    }
  } catch {
    // ignore → ENV fallback
  }

  // ENV(APPOINTMENT_VALUES) フォールバック（配列/カンマ区切り両対応）
  const raw: any = APPOINTMENT_VALUES;
  const envVals = Array.isArray(raw) ? raw : (typeof raw === "string" ? raw.split(",") : []);
  return envVals.map(lc).includes(v);
}

/** 現状は共通の既定 XP（将来拡張可） */
export function xpForAppointment(_tenant: string, _outcome: string): number {
  return APPOINTMENT_XP;
}
