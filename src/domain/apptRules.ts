// @ts-nocheck
// src/domain/apptRules.ts
// アポ判定のフォールバック（UIのラベルが無い場合は ENV を見る）
// ここでは「判定」だけに限定し、XP計算は features/appointment.ts 側で集約します。

import { APPOINTMENT_VALUES, APPOINTMENT_XP } from "../lib/env.js";
import { getObservedLabelIds, getObservedLabelTitles } from "../store/labels.js";

// 文字列安全化
const asStr = (v: unknown): string => "" + (v ?? "");
const lc = (v: unknown): string => asStr(v).toLowerCase();

/**
 * outcome（ラベルIDやタイトル）が「アポとして数える対象か」を判定。
 * テナント固有のラベルID/タイトルがあればそれを優先。無ければ ENV(APPOINTMENT_VALUES) を使用。
 */
export async function isAppointmentOutcome(tenant: string, outcome: string): Promise<boolean> {
  const v = lc(outcome).trim();
  if (!v) return false;

  try {
    // テナント固有の設定（UI 保存分）
    const ids = ((await getObservedLabelIds(tenant)) ?? []).map(lc);
    const titles = ((await getObservedLabelTitles(tenant)) ?? []).map(lc);
    if (ids.length || titles.length) {
      return ids.includes(v) || titles.includes(v);
    }
  } catch {
    // 何もしない（ENV にフォールバック）
  }

  // 環境変数の既定
  const envVals = (APPOINTMENT_VALUES ?? []).map(lc);
  return envVals.includes(v);
}

/** 今は共通の既定 XP を返す（将来テナント別/ラベル別に拡張可能） */
export function xpForAppointment(_tenant: string, _outcome: string): number {
  return APPOINTMENT_XP;
}
