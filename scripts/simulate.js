// バランス調整用：ランダムな選択で自動プレイして結果の分布を表示する
// 使い方: node scripts/simulate.js [回数]
import {
  createGame, rollDice, planMove, stepTo, moveBack, moveOf, squareOf, openSquare, choose,
  consumeSkip, finishTurn, computeScore,
} from '../js/engine.js';
import { RANKS, ROUTES } from '../js/constants.js';

/**
 * 立ち止まったマスのイベントを処理し、「進む／戻る」も解決する。
 * 移動先のイベントは発生しないが、決算日に着いたときだけは決算日を処理する。
 */
function resolveSquare(state, rng, chooseIndex, pick) {
  const { event } = openSquare(state, rng);
  let outcome;
  if (event.choices?.length) ({ outcome } = choose(state, event, chooseIndex(event), rng));
  const move = moveOf(event, outcome);
  if (move < 0) moveBack(state, -move);
  if (move > 0) {
    for (const pos of planMove(state, move, pick)) stepTo(state, pos);
    if (squareOf(state.position).stop) resolveSquare(state, rng, chooseIndex, pick);
  }
  return move;
}

export function playAuto(options, rng = Math.random, strategy = 'random') {
  const state = createGame(options);
  const chooseIndex = (event) => (strategy === 'first' ? 0 : Math.floor(rng() * event.choices.length));
  const pick = (square) => (strategy === 'first' ? 0 : Math.floor(rng() * square.branches.length));
  let guard = 0;
  while (!state.gameOver && guard < 2000) {
    guard += 1;
    if (consumeSkip(state)) continue;
    for (const pos of planMove(state, rollDice(rng), pick)) stepTo(state, pos);
    resolveSquare(state, rng, chooseIndex, pick);
    finishTurn(state);
  }
  return state;
}

function summarize(years, route, strategy, n) {
  const ranks = new Map();
  const titles = new Map();
  let turns = 0;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const s = playAuto({ name: 'sim', route, years }, Math.random, strategy);
    const score = computeScore(s);
    turns += s.turn;
    total += score.total;
    ranks.set(RANKS[s.rankIndex].name, (ranks.get(RANKS[s.rankIndex].name) ?? 0) + 1);
    titles.set(score.title.name, (titles.get(score.title.name) ?? 0) + 1);
  }
  const pct = (m) => [...m.entries()].map(([k, v]) => `${k}:${Math.round((v / n) * 100)}%`).join(' ');
  console.log(`[${years}期/${ROUTES[route].name}/${strategy}] 平均ターン ${(turns / n).toFixed(1)} 平均点 ${(total / n).toFixed(0)}`);
  console.log(`  役職 ${pct(ranks)}`);
  console.log(`  称号 ${pct(titles)}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const n = Number(process.argv[2] ?? 2000);
  for (const years of [1, 3, 5]) {
    for (const route of Object.keys(ROUTES)) {
      for (const strategy of ['random', 'first']) summarize(years, route, strategy, n);
    }
  }
}
