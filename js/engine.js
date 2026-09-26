// ゲーム進行ロジック（DOM に依存しない）
import { MONTH_ORDER, ROUTES, RANKS, CERTS } from './constants.js';
import { SQUARES, LANES, lanesOnTrail } from './events.js';
import { clamp, monthlySalary, livingCost, currentRank } from './rules.js';

export const SAVE_VERSION = 2;
export const SAVE_KEY = 'accounting-life-game-save-v2';
export const STAT_KEYS = ['money', 'investment', 'skill', 'trust', 'stress'];
export const MAX_LOG = 80;

export { SQUARES, LANES, lanesOnTrail };

const SQUARE_MAP = new Map(SQUARES.map((s) => [s.id, s]));
export const START_ID = SQUARES[0].id;
export const GOAL_ID = SQUARES.find((s) => s.stop).id;

export function squareOf(id) {
  const square = SQUARE_MAP.get(id);
  if (!square) throw new Error(`unknown square: ${id}`);
  return square;
}

export function monthOf(id) {
  return squareOf(id).month;
}

export function createGame({ name = 'あなた', route = 'newgrad', years = 3 } = {}) {
  const r = ROUTES[route] ?? ROUTES.newgrad;
  return {
    version: SAVE_VERSION,
    name: String(name).trim().slice(0, 12) || 'あなた',
    route: ROUTES[route] ? route : 'newgrad',
    totalYears: years,
    year: 1,
    position: START_ID,
    trail: [START_ID],
    paidThrough: -1,
    turn: 0,
    rankIndex: 0,
    money: r.money,
    investment: 0,
    skill: r.skill,
    trust: r.trust,
    stress: r.stress,
    certs: [...r.certs],
    married: false,
    children: 0,
    house: false,
    skipTurns: 0,
    usedQuiz: [],
    quizStats: { correct: 0, total: 0 },
    history: [],
    log: [],
    gameOver: false,
  };
}

/** 乱数ヘルパーを束ねたコンテキスト */
export function makeCtx(state, rng = Math.random) {
  return {
    state,
    rng,
    dice: () => 1 + Math.floor(rng() * 6),
    pick: (arr) => arr[Math.floor(rng() * arr.length)],
    shuffle: (arr) => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
}

export function rollDice(rng = Math.random) {
  return 1 + Math.floor(rng() * 6);
}

/** 次に進むマス。分かれ道では branchIndex 番目のルートへ */
export function nextSquare(position, branchIndex = 0) {
  const { next } = squareOf(position);
  return next[branchIndex] ?? next[0];
}

/**
 * 進むマスの一覧（決算日などの「止まれ」マスで停止）。
 * 分かれ道では pick(分かれ道のマス) が返す番号のルートへ進む。
 */
export function planMove(state, steps, pick = () => 0) {
  const path = [];
  let pos = state.position;
  for (let i = 0; i < steps; i += 1) {
    const square = squareOf(pos);
    pos = nextSquare(pos, square.branches ? pick(square) : 0);
    path.push(pos);
    if (squareOf(pos).stop) break;
  }
  return path;
}

/**
 * 1マス進める。月をまたいだら前月分の給料日（同じ月の給料は1期に1回だけ）。
 * 3月分の給料は決算日マスで支給するため、決算日→4月の移動では支給しない。
 */
export function stepTo(state, id) {
  const from = squareOf(state.position);
  const to = squareOf(id);
  if (!from.next.includes(id)) throw new Error(`cannot move ${from.id} -> ${id}`);
  state.position = id;
  if (from.stop) {
    state.trail = [id];
    state.paidThrough = -1;
    return {};
  }
  state.trail.push(id);
  if (from.month === to.month) return {};
  const monthIndex = MONTH_ORDER.indexOf(from.month);
  if (monthIndex <= state.paidThrough) return {};
  state.paidThrough = monthIndex;
  const salary = monthlySalary(state);
  const living = livingCost(state);
  state.money += salary - living;
  return { payday: { month: from.month, salary, living, net: salary - living } };
}

/** 通ってきた道を steps マス戻る（期首より前には戻らない）。通ったマスの一覧を返す */
export function moveBack(state, steps) {
  const path = [];
  while (path.length < steps && state.trail.length > 1) {
    state.trail.pop();
    state.position = state.trail[state.trail.length - 1];
    path.push(state.position);
  }
  return path;
}

/** イベントの結果で進む（＋）／戻る（−）マス数 */
export function moveOf(event, outcome) {
  return (outcome ? outcome.move : event.move) ?? 0;
}

/** 今いるルート（分かれ道の先にいないときは null） */
export function currentLane(state) {
  const lane = squareOf(state.position).lane;
  return lane ? { id: lane, ...LANES[lane] } : null;
}

export function applyEffects(state, effects = {}) {
  const deltas = [];
  for (const key of STAT_KEYS) {
    const value = effects[key];
    if (!value) continue;
    const before = state[key];
    let after = before + value;
    if (key === 'stress') after = clamp(after, 0, 100);
    if (key === 'skill' || key === 'trust' || key === 'investment') after = Math.max(0, after);
    state[key] = after;
    if (after !== before) deltas.push({ key, value: after - before });
  }
  return deltas;
}

function applyOutcome(state, outcome) {
  const deltas = applyEffects(state, outcome.effects);
  if (typeof outcome.apply === 'function') outcome.apply(state);
  return deltas;
}

/** 止まったマスのイベントを生成し、即時効果を適用する */
export function openSquare(state, rng = Math.random) {
  const square = squareOf(state.position);
  const event = square.event(makeCtx(state, rng));
  event.text = [].concat(event.text ?? []);
  const deltas = applyOutcome(state, event);
  return { square, event, deltas };
}

/** 選択肢を選んだ結果を適用する */
export function choose(state, event, index, rng = Math.random) {
  const choice = event.choices?.[index];
  if (!choice) throw new Error(`invalid choice: ${index}`);
  const outcome = choice.run(makeCtx(state, rng)) ?? {};
  outcome.text = [].concat(outcome.text ?? []);
  const deltas = applyOutcome(state, outcome);
  return { outcome, deltas };
}

/** 1回休みの消化 */
export function consumeSkip(state) {
  if (state.skipTurns <= 0) return false;
  state.skipTurns -= 1;
  state.turn += 1;
  return true;
}

/** ターン終了処理（ストレス限界チェックなど） */
export function finishTurn(state) {
  state.turn += 1;
  const result = { burnout: false, gameOver: state.gameOver };
  if (!state.gameOver && state.stress >= 100) {
    state.stress = 60;
    state.trust = Math.max(0, state.trust - 3);
    state.skipTurns += 1;
    result.burnout = true;
  }
  return result;
}

export function addLog(state, text) {
  state.log.unshift({ turn: state.turn, year: state.year, text });
  if (state.log.length > MAX_LOG) state.log.length = MAX_LOG;
}

// ---------------------------------------------------------------- score

const TITLES = [
  { min: 1.9, icon: '👑', name: '伝説のCFO', comment: '経理の枠を超え、会社の未来を数字で描く存在に。' },
  { min: 1.45, icon: '🌟', name: '敏腕経理パーソン', comment: '決算も税務も任せて安心。社内外から頼られる存在。' },
  { min: 1.1, icon: '💼', name: '頼れる経理のエース', comment: '期日を守り、ミスを防ぐ。チームの要。' },
  { min: 0.75, icon: '📒', name: '一人前の経理担当', comment: '仕訳も決算もひととおりこなせるようになった。' },
  { min: -Infinity, icon: '🌱', name: '経理ルーキー', comment: '伸びしろしかない！次の期はもっと上を目指そう。' },
];

/** 期数に応じた基準点（この点で倍率 1.0。scripts/simulate.js の平均点をもとに調整） */
const BASE_SCORES = { 1: 210, 3: 680, 5: 1420 };

export function baseScore(years) {
  return BASE_SCORES[years] ?? 300 * years;
}

export function computeScore(state) {
  const rank = currentRank(state);
  const assets = state.money + state.investment;
  const certPoints = state.certs.reduce((sum, id) => sum + (CERTS[id]?.points ?? 0), 0);
  const familyPoints = (state.married ? 50 : 0) + state.children * 30 + (state.house ? 100 : 0);
  const items = [
    { label: `資産（${Math.round(assets / 10000).toLocaleString('ja-JP')}万円・1万円＝1pt）`, value: Math.floor(assets / 10000) },
    { label: `役職（${rank.name}）`, value: rank.points },
    { label: `資格（${state.certs.length ? state.certs.map((id) => CERTS[id].short).join('・') : 'なし'}）`, value: certPoints },
    { label: 'スキル', value: state.skill },
    { label: '信頼', value: state.trust },
    { label: '家族・マイホーム', value: familyPoints },
    { label: 'ストレス（½を減点）', value: -Math.floor(state.stress / 2) },
  ];
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const ratio = total / baseScore(state.totalYears);
  const title = TITLES.find((t) => ratio >= t.min);
  return { items, total, title };
}

export function rankNames() {
  return RANKS.map((r) => r.name);
}

// ---------------------------------------------------------------- save / load

export function serialize(state) {
  return JSON.stringify(state);
}

export function deserialize(json) {
  try {
    const data = JSON.parse(json);
    if (!data || data.version !== SAVE_VERSION || !SQUARE_MAP.has(data.position)) return null;
    if (!Array.isArray(data.trail) || !data.trail.every((id) => SQUARE_MAP.has(id))) return null;
    return data;
  } catch {
    return null;
  }
}
