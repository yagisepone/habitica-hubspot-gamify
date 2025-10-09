import { APPOINTMENT_VALUES, APPOINTMENT_XP } from "../lib/env.js";
import { getObservedLabelIds, getObservedLabelTitles } from "../store/labels.js";

/**
 * outcome（ラベルIDやタイトル）が「アポとして数える対象かどうか」を判定します。
 * テナント固有のラベルID/タイトルを優先し、それが無い場合は ENV の APPOINTMENT_VALUES を使用します。
 *
 * @param {string} tenant テナントID
 * @param {string} outcome HubSpotなどから渡される outcome（ラベルIDやステータス）
 * @returns {boolean} trueの場合アポとして扱う
 */
export function isAppointmentOutcome(tenant: string, outcome: string): boolean {
  const v = String(outcome || "").trim().toLowerCase();
  if (!v) return false;

  // テナント別に登録されているラベルID/タイトルを取得
  const ids = (getObservedLabelIds(tenant) || []).map((s) => String(s).toLowerCase());
  const titles = (getObservedLabelTitles(tenant) || []).map((s) => String(s).toLowerCase());

  // テナント別設定が存在する場合はそちらを優先
  if (ids.length || titles.length) {
    return ids.includes(v) || titles.includes(v);
  }

  // フォールバック：環境変数 APPOINTMENT_VALUES
  const envVals = (APPOINTMENT_VALUES || []).map((s) => String(s).toLowerCase());
  return envVals.includes(v);
}

/**
 * アポのXPを決定します。
 * 現状は共通の APPOINTMENT_XP を返しますが、将来的にラベル別XPへ拡張可能です。
 *
 * @param {string} tenant テナントID
 * @param {string} outcome ラベルIDやステータス
 * @returns {number} 付与するXP
 */
export function xpForAppointment(tenant: string, outcome: string): number {
  // 将来的に tenant ごとの XP が必要ならここで lookup します
  return APPOINTMENT_XP;
}
