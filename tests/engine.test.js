import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SQUARES, LANES, START_ID, GOAL_ID, createGame, planMove, stepTo, moveBack, moveOf, squareOf,
  nextSquare, currentLane, openSquare, choose, finishTurn, consumeSkip, computeScore,
  serialize, deserialize, monthOf, applyEffects, lanesOnTrail,
} from '../js/engine.js';
import { promotionResult, BOARD_COLS, BOARD_ROWS, SIGNS } from '../js/events.js';
import { QUIZZES } from '../js/quizzes.js';
import { MONTH_ORDER, RANKS, ROUTES } from '../js/constants.js';
import { monthlySalary, livingCost, formatYen } from '../js/rules.js';
import { playAuto } from '../scripts/simulate.js';

/** 再現性のある乱数（mulberry32） */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FORKS = SQUARES.filter((s) => s.branches);

/** スタートからゴールまでの全ルート（分かれ道の選び方すべて）を列挙する */
function allPaths() {
  const paths = [];
  for (let mask = 0; mask < 2 ** FORKS.length; mask += 1) {
    const path = [START_ID];
    let pos = START_ID;
    while (pos !== GOAL_ID) {
      const square = squareOf(pos);
      const branch = square.branches ? (mask >> FORKS.indexOf(square)) & 1 : 0;
      pos = nextSquare(pos, branch);
      path.push(pos);
    }
    paths.push({ mask, path });
  }
  return paths;
}

/** 分かれ道の選び方を固定して1マスずつ歩く */
function walk(state, until, mask = 0) {
  const results = [];
  while (state.position !== until) {
    const square = squareOf(state.position);
    const branch = square.branches ? (mask >> FORKS.indexOf(square)) & 1 : 0;
    results.push(stepTo(state, nextSquare(state.position, branch)));
  }
  return results;
}

test('盤面：スタートが4月、ゴールの決算日だけが止まるマスで、全マスがつながっている', () => {
  assert.equal(squareOf(START_ID).month, 4);
  assert.equal(squareOf(GOAL_ID).month, 3);
  assert.equal(SQUARES.filter((s) => s.stop).length, 1);
  assert.deepEqual(squareOf(GOAL_ID).next, [START_ID]);
  const ids = new Set(SQUARES.map((s) => s.id));
  assert.equal(ids.size, SQUARES.length, 'id が重複していない');
  const reached = new Set();
  for (const square of SQUARES) {
    assert.equal(typeof square.event, 'function', square.name);
    assert.ok(square.name && square.icon && square.type);
    assert.ok(MONTH_ORDER.includes(square.month), square.name);
    for (const id of square.next) {
      assert.ok(ids.has(id), `${square.id} -> ${id}`);
      reached.add(id);
    }
  }
  assert.equal(reached.size, SQUARES.length, 'どのマスにも入ってくる道がある');
});

test('盤面：分かれ道は3か所で、それぞれ2つのルートに分かれる', () => {
  assert.equal(FORKS.length, 3);
  const lanes = new Set();
  for (const fork of FORKS) {
    assert.equal(fork.branches.length, 2);
    assert.deepEqual(fork.branches.map((b) => b.to), fork.next);
    for (const b of fork.branches) {
      assert.ok(LANES[b.lane], b.lane);
      assert.ok(b.name && b.desc && b.icon);
      assert.equal(b.length, SQUARES.filter((s) => s.lane === b.lane).length);
      lanes.add(b.lane);
    }
  }
  assert.equal(lanes.size, Object.keys(LANES).length);
  assert.deepEqual(new Set(SIGNS.flatMap((s) => s.lanes)), lanes, '案内板で全ルートを案内している');
});

test('盤面：マスの配置が盤面内で重ならず、道は隣のマス同士をつなぐ', () => {
  const cells = new Set();
  for (const square of SQUARES) {
    const [x, y] = square.at;
    assert.ok(x >= 0 && x < BOARD_COLS && y >= 0 && y < BOARD_ROWS, square.id);
    const key = `${x},${y}`;
    assert.ok(!cells.has(key), `${square.id} が重なっている`);
    cells.add(key);
    for (const id of square.next) {
      if (square.stop) continue; // 決算日→期首は盤面上では線を引かない
      const [nx, ny] = squareOf(id).at;
      assert.ok(Math.abs(nx - x) <= 1 && Math.abs(ny - y) <= 2, `${square.id} -> ${id}`);
    }
  }
  for (const sign of SIGNS) {
    for (let dx = 0; dx < sign.width; dx += 1) {
      assert.ok(!cells.has(`${sign.at[0] + dx},${sign.at[1]}`), '案内板がマスと重なっていない');
    }
  }
});

test('全ルートで月が4月→3月の順に進み、どの月も通る（ルートは約45マス）', () => {
  const paths = allPaths();
  assert.equal(paths.length, 8);
  for (const { path } of paths) {
    const months = path.map((id) => MONTH_ORDER.indexOf(monthOf(id)));
    for (let i = 1; i < months.length; i += 1) assert.ok(months[i] >= months[i - 1], path.join(','));
    assert.equal(new Set(months).size, 12);
    assert.ok(path.length >= 40 && path.length <= 50, `${path.length}マス`);
    assert.equal(lanesOnTrail(path).length, 3);
  }
});

test('決算日を越えて進もうとしても決算日で止まる', () => {
  const s = createGame();
  const beforeGoal = SQUARES.find((sq) => sq.next.includes(GOAL_ID));
  s.position = beforeGoal.id;
  assert.deepEqual(planMove(s, 6), [GOAL_ID]);
  s.position = GOAL_ID;
  assert.deepEqual(planMove(s, 3), [START_ID, nextSquare(START_ID), nextSquare(nextSquare(START_ID))]);
});

test('分かれ道では選んだルートへ進み、つながっていないマスには進めない', () => {
  const [fork] = FORKS;
  const s = createGame();
  walk(s, fork.id);
  assert.deepEqual(planMove(s, 1, () => 0), [fork.branches[0].to]);
  assert.deepEqual(planMove(s, 1, () => 1), [fork.branches[1].to]);
  const seen = [];
  planMove(s, 2, (square) => { seen.push(square.id); return 1; });
  assert.deepEqual(seen, [fork.id], '分かれ道でだけ選択を聞かれる');
  assert.throws(() => stepTo(s, GOAL_ID));
  stepTo(s, fork.branches[1].to);
  assert.equal(currentLane(s).id, fork.branches[1].lane);
  assert.deepEqual(lanesOnTrail(s.trail), [fork.branches[1].lane]);
});

test('どのルートでも、1年間の給料日は11回＋決算日の3月分で12回', () => {
  for (const { mask } of allPaths()) {
    const s = createGame({ route: 'newgrad' });
    const net = monthlySalary(s) - livingCost(s);
    const paydays = walk(s, GOAL_ID, mask).map((r) => r.payday).filter(Boolean);
    assert.deepEqual(paydays.map((p) => p.month), [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2], `mask=${mask}`);
    for (const p of paydays) assert.equal(p.net, net);
    const moneyBefore = s.money;
    const { event } = openSquare(s, seeded(1));
    assert.equal(event.kind, 'closing');
    assert.equal(s.money, moneyBefore + net, '3月分の給料は決算日に支給');
    assert.equal(stepTo(s, START_ID).payday, undefined, '決算日→4月では給料日にならない');
    assert.deepEqual(s.trail, [START_ID], '新しい期は道の記録がリセットされる');
  }
});

test('Xマス戻る：通ってきた道を引き返し、分かれ道より前まで戻ればルートを選び直せる', () => {
  const [fork] = FORKS;
  const s = createGame();
  walk(s, fork.id);
  const trailAtFork = [...s.trail];
  stepTo(s, fork.branches[0].to);
  stepTo(s, nextSquare(s.position));
  assert.deepEqual(lanesOnTrail(s.trail), [fork.branches[0].lane]);

  const back = moveBack(s, 3);
  assert.equal(back.length, 3);
  assert.equal(s.position, trailAtFork[trailAtFork.length - 2]);
  assert.deepEqual(s.trail, trailAtFork.slice(0, -1));
  assert.deepEqual(lanesOnTrail(s.trail), [], '分かれ道より前に戻るとルートの記録も消える');

  // もう一度進むと、別のルートを選べる
  stepTo(s, fork.id);
  stepTo(s, fork.branches[1].to);
  assert.equal(currentLane(s).id, fork.branches[1].lane);

  // 期首より前には戻らない
  const t = createGame();
  stepTo(t, nextSquare(t.position));
  assert.equal(moveBack(t, 5).length, 1);
  assert.equal(t.position, START_ID);
  assert.deepEqual(t.trail, [START_ID]);
});

test('戻ってから同じ月の境目を越えても、給料は二重にもらえない', () => {
  const s = createGame();
  const may = SQUARES.find((sq) => sq.month === 5);
  walk(s, may.id);
  const money = s.money;
  assert.equal(s.paidThrough, 0, '4月分は支給済み');
  moveBack(s, 2);
  assert.equal(monthOf(s.position), 4);
  walk(s, may.id);
  assert.equal(s.money, money);
  const results = walk(s, GOAL_ID);
  assert.equal(results.filter((r) => r.payday).length, 10, '5〜2月分');
});

test('「進む」「戻る」マス：イベントの結果にマス数がつき、自動プレイでも処理される', () => {
  const moveSquares = SQUARES.filter((sq) => sq.type === 'move');
  assert.ok(moveSquares.length >= 3);
  let forward = 0;
  let backward = 0;
  for (const square of moveSquares) {
    for (let seed = 1; seed <= 30; seed += 1) {
      const s = createGame();
      s.position = square.id;
      const { event } = openSquare(s, seeded(seed));
      const move = moveOf(event);
      if (move > 0) forward += 1;
      if (move < 0) backward += 1;
      if (move) assert.ok(event.text.some((t) => t.includes(`${Math.abs(move)}マス`)), event.title);
    }
  }
  assert.ok(forward > 0 && backward > 0);
  assert.equal(moveOf({ move: 2 }, { text: [] }), 0, '選択肢がある場合は選んだ結果の move を使う');
  assert.equal(moveOf({}, { move: -2 }), -2);
});

test('ステータスの上下限（ストレス0〜100、スキル・信頼は0以上）', () => {
  const s = createGame();
  applyEffects(s, { stress: 500, skill: -999, trust: -999 });
  assert.equal(s.stress, 100);
  assert.equal(s.skill, 0);
  assert.equal(s.trust, 0);
  applyEffects(s, { stress: -500 });
  assert.equal(s.stress, 0);
});

test('ストレス100で1回休み', () => {
  const s = createGame();
  s.stress = 100;
  const r = finishTurn(s);
  assert.equal(r.burnout, true);
  assert.equal(s.skipTurns, 1);
  assert.equal(s.stress, 60);
  assert.equal(consumeSkip(s), true);
  assert.equal(s.skipTurns, 0);
  assert.equal(consumeSkip(s), false);
});

test('昇進：評価ptで昇進し、課長には簿記2級、CFOには簿記1級が必要', () => {
  const s = createGame();
  s.skill = 100;
  s.trust = 40;
  let p = promotionResult(s);
  assert.equal(RANKS[p.to].id, 'leader');
  assert.equal(p.to - p.from, 2, '1回の決算で最大2段階');

  s.rankIndex = 2;
  s.skill = 150;
  s.trust = 100;
  p = promotionResult(s);
  assert.equal(p.to, 2);
  assert.equal(p.blockedBy.id, 'manager');

  s.certs = ['boki3', 'boki2'];
  p = promotionResult(s);
  assert.equal(RANKS[p.to].id, 'manager', '250pt なら課長まで');
  s.trust = 130;
  p = promotionResult(s);
  assert.equal(RANKS[p.to].id, 'director', '280pt で部長');

  s.rankIndex = 4;
  s.skill = 300;
  s.trust = 150;
  assert.equal(promotionResult(s).blockedBy.id, 'cfo');
  s.certs.push('boki1');
  assert.equal(RANKS[promotionResult(s).to].id, 'cfo');
});

test('決算日で期が進み、選んだルートが記録され、最終期ならゲーム終了', () => {
  const s = createGame({ years: 2 });
  walk(s, GOAL_ID, 0b101);
  openSquare(s, seeded(2));
  assert.equal(s.year, 2);
  assert.equal(s.gameOver, false);
  assert.deepEqual(s.history[0].lanes, [FORKS[0].branches[1].lane, FORKS[1].branches[0].lane, FORKS[2].branches[1].lane]);
  stepTo(s, START_ID);
  walk(s, GOAL_ID, 0);
  openSquare(s, seeded(3));
  assert.equal(s.gameOver, true);
  assert.equal(s.history.length, 2);
  assert.deepEqual(s.history[1].lanes, FORKS.map((f) => f.branches[0].lane));
});

test('クイズデータ：4択で選択肢の重複がなく、正解インデックスが有効', () => {
  assert.ok(QUIZZES.length >= 20);
  for (const q of QUIZZES) {
    assert.equal(q.choices.length, 4, q.q);
    assert.equal(new Set(q.choices).size, 4, q.q);
    assert.ok(q.answer >= 0 && q.answer < 4, q.q);
    assert.ok(q.explain.length > 0);
  }
});

test('全マスのイベントと全選択肢が、さまざまな状態でエラーなく実行できる', () => {
  const variants = [
    {},
    { married: true, children: 1, money: 5_000_000 },
    { certs: ['boki3', 'boki2', 'boki1'], rankIndex: 5, skill: 250, trust: 150 },
    { certs: ['boki3', 'boki2'], money: -100_000, stress: 95 },
  ];
  let seed = 10;
  for (const variant of variants) {
    for (const square of SQUARES) {
      for (let trial = 0; trial < 6; trial += 1) {
        const base = { ...createGame({ years: 5 }), ...variant, position: square.id };
        const probe = structuredClone(base);
        const { event } = openSquare(probe, seeded(seed += 1));
        assert.ok(event.title, `title @${square.id}`);
        assert.ok(Array.isArray(event.text) && event.text.length > 0, `text @${square.id}`);
        assert.ok(Number.isInteger(moveOf(event)), `move @${square.id}`);
        const count = event.choices?.length ?? 0;
        for (let c = 0; c < count; c += 1) {
          const s = structuredClone(base);
          const opened = openSquare(s, seeded(seed));
          const { outcome } = choose(s, opened.event, c, seeded(seed + 1));
          assert.ok(outcome.text.length > 0, `outcome @${square.id}#${c}`);
          assert.ok(Number.isInteger(moveOf(opened.event, outcome)), `move @${square.id}#${c}`);
          for (const key of ['money', 'skill', 'trust', 'stress', 'investment']) {
            assert.ok(Number.isFinite(s[key]), `${key} @${square.id}#${c}`);
          }
        }
      }
    }
  }
});

test('自動プレイで1・3・5期とも最後まで遊べる（全入社ルート・分かれ道はランダム）', () => {
  let seed = 100;
  for (const years of [1, 3, 5]) {
    for (const route of Object.keys(ROUTES)) {
      for (let i = 0; i < 20; i += 1) {
        const s = playAuto({ route, years }, seeded(seed += 1));
        assert.equal(s.gameOver, true);
        assert.equal(s.history.length, years);
        assert.equal(s.position, GOAL_ID);
        for (const h of s.history) assert.equal(h.lanes.length, 3, '各期で分かれ道を3回通る');
        const score = computeScore(s);
        assert.ok(Number.isFinite(score.total));
        assert.ok(score.title.name);
        assert.equal(score.total, score.items.reduce((a, b) => a + b.value, 0));
      }
    }
  }
});

test('セーブデータの保存と復元', () => {
  const s = playAuto({ years: 1 }, seeded(7));
  const restored = deserialize(serialize(s));
  assert.deepEqual(restored, s);
  assert.equal(deserialize('not json'), null);
  assert.equal(deserialize('{"version":999}'), null);
  assert.equal(deserialize(JSON.stringify({ ...s, version: 1, position: 3 })), null, '一本道時代の古いセーブは読み込まない');
  assert.equal(deserialize(JSON.stringify({ ...s, position: 'zz9' })), null);
});

test('金額表示', () => {
  assert.equal(formatYen(5000), '5,000円');
  assert.equal(formatYen(220000), '22万円');
  assert.equal(formatYen(1234567), '123.5万円');
  assert.equal(formatYen(-500000), '-50万円');
});
