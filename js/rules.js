// 状態から値を計算する純粋関数群
import {
  RANKS, CERTS, MANAGER_RANK_INDEX,
  BASE_LIVING_COST, CHILD_LIVING_COST, HOUSE_LIVING_COST,
} from './constants.js';

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function currentRank(state) {
  return RANKS[state.rankIndex];
}

/** 資格手当の合計（月額） */
export function allowance(state) {
  return state.certs.reduce((sum, id) => sum + (CERTS[id]?.allowance ?? 0), 0);
}

/** 月給（手取りのイメージ）＝ 役職の給与＋資格手当 */
export function monthlySalary(state) {
  return currentRank(state).salary + allowance(state);
}

/** 毎月の生活費 */
export function livingCost(state) {
  return BASE_LIVING_COST
    + state.children * CHILD_LIVING_COST
    + (state.house ? HOUSE_LIVING_COST : 0);
}

/** 判定に加算されるスキル補正（スキル20ごとに+1） */
export function skillBonus(state) {
  return Math.floor(Math.max(0, state.skill) / 20);
}

export function isManager(state) {
  return state.rankIndex >= MANAGER_RANK_INDEX;
}

/** 期末評価ポイント */
export function evaluationPoints(state) {
  return state.skill + state.trust;
}

/** 賞与の支給月数（信頼が高いほど多い：1.5〜2.5か月） */
export function bonusMonths(state) {
  return 1.5 + clamp(state.trust, 0, 100) / 100;
}

export function bonusAmount(state) {
  return Math.round((currentRank(state).salary * bonusMonths(state)) / 1000) * 1000;
}

/** 金額表示（1万円以上は「万円」表記） */
export function formatYen(n) {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 10000) {
    const man = Math.round(abs / 1000) / 10;
    return `${sign}${man.toLocaleString('ja-JP')}万円`;
  }
  return `${sign}${abs.toLocaleString('ja-JP')}円`;
}

export function signedYen(n) {
  return n >= 0 ? `+${formatYen(n)}` : formatYen(n);
}
