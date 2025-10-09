// @ts-nocheck
// src/domain/apptRules.ts

import { APPOINTMENT_VALUES, APPOINTMENT_XP } from "../lib/env.js";
import { getObservedLabelIds, getObservedLabelTitles } from "../store/labels.js";

// 文字列安全化
const asStr = (v: unknown): string => "" + (v ?? "");
const lc = (v: unknown): string => asStr(v).toLowerCase();
const arr = (v: any): any[] =>
  Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);

/**
 * outcome（ラベルIDやタイトル）が「アポとして数える対象か」を判定。
 * テナント固有のラベルID/タイトルがあれば優先。無ければ ENV を使用。
 */
export async function isAppointmentOutcome(tenant: string, outcome: string): Promise<boolean> {
  const v = lc(outcome).trim();
  if (!v) return false;

  try {
    const ids = arr(await getObservedLabelIds(tenant)).map(lc);
    const titles = arr(await getObservedLabelTitles(tenant)).map(lc);
    if (ids.length || titles.length) {
      return ids.includes(v) || titles.includes(v);
    }
  } catch {
    // ignore → ENV fallback
  }

  const envValsRaw: any = APPOINTMENT_VALUES;
  const envVals = Array.isArray(envValsRaw)
    ? envValsRaw
    : (typeof envValsRaw === "string" ? envValsRaw.split(",") : []);
  return envVals.map(lc).includes(v);
}

/** 現状は共通の既定 XP（将来拡張可） */
export function xpForAppointment(_tenant: string, _outcome: string): number {
  return APPOINTMENT_XP;
}
