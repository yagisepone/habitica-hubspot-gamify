import { APPOINTMENT_VALUES, APPOINTMENT_XP } from "../lib/env.js";
import { getObservedLabelIds, getObservedLabelTitles } from "../store/labels.js";

/** 安全な小文字変換（String(...) を使わない） */
const lc = (v: unknown): string => ("" + (v ?? "")).toLowerCase();

/**
 * outcome（ラベルIDやタイトル）が「アポとして数える対象かどうか」を判定します。
 * テナント固有のラベルID/タイトルを優先し、それが無い場合は ENV(APPOINTMENT_VALUES) を使用します。
 */
export async function isAppointmentOutcome(
  tenant: string,
  outcome: string
): Promise<boolean> {
  const v = lc(outcome).trim();
  if (!v) return false;

  // テナント固有設定（非同期）
  const ids =
    ((await getObservedLabelIds(tenant)) ?? []).map((s: unknown) => lc(s));
  const titles =
    ((await getObservedLabelTitles(tenant)) ?? []).map((s: unknown) => lc(s));

  if (ids.length || titles.length) {
    return ids.includes(v) || titles.includes(v);
  }

  // フォールバック：ENV の APPOINTMENT_VALUES
  const envVals = (APPOINTMENT_VALUES ?? []).map((s: unknown) => lc(s));
  return envVals.includes(v);
}

/** 現状は共通の既定 XP を返す（将来ラベル別/テナント別も可） */
export function xpForAppointment(_tenant: string, _outcome: string): number {
  return APPOINTMENT_XP;
}
