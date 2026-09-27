// 画面制御
import {
  SQUARES, LANES, START_ID, SAVE_KEY, createGame, rollDice, nextSquare, stepTo, moveBack, moveOf,
  squareOf, currentLane, lanesOnTrail, openSquare, choose, consumeSkip, finishTurn, addLog,
  computeScore, serialize, deserialize, monthOf,
} from './engine.js';
import { BOARD_COLS, BOARD_ROWS, SIGNS } from './events.js';
import { ROUTES, LENGTHS, RANKS, CERTS } from './constants.js';
import { formatYen, signedYen, monthlySalary, livingCost, evaluationPoints, skillBonus } from './rules.js';

const STEP_MS = 230;
const rng = Math.random;

/** 盤面の1マス分の大きさ（px）。拡大縮小はカメラで行う */
const UNIT = 110;

/** カメラのモードごとの既定の傾き */
const VIEW_TILT = { follow: 52, overview: 30 };
const TILT_RANGE = [0, 70];

const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 要素生成ヘルパー（文字列は textContent として扱う） */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

let state = null;
let busy = false;
let toastTimer = null;
let cells = new Map();
let roads = new Map();
const view = { mode: 'follow', tilt: VIEW_TILT.follow, spin: 0 };
const dice = { x: 0, y: 0 };

// ---------------------------------------------------------------- screens

function showScreen(id) {
  for (const screen of document.querySelectorAll('.screen')) screen.hidden = screen.id !== id;
  clearTimeout(toastTimer);
  $('#toast').hidden = true;
  window.scrollTo(0, 0);
}

function save() {
  try {
    localStorage.setItem(SAVE_KEY, serialize(state));
  } catch {
    // プライベートモードなどで保存できない場合は無視
  }
}

function loadSave() {
  try {
    const json = localStorage.getItem(SAVE_KEY);
    return json ? deserialize(json) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- title

function setupTitle() {
  const routeBox = $('#route-options');
  Object.entries(ROUTES).forEach(([id, r], i) => {
    const certs = r.certs.length ? `／${r.certs.map((c) => CERTS[c].short).join('・')}` : '';
    routeBox.append(el('label', { class: 'option' },
      el('input', { type: 'radio', name: 'route', value: id, checked: i === 0 }),
      el('div', { class: 'option-title', text: r.name }),
      el('div', { class: 'option-desc', text: r.desc }),
      el('div', { class: 'option-stats', text: `スキル${r.skill}／信頼${r.trust}／所持金${formatYen(r.money)}${certs}` })));
  });

  const lengthBox = $('#length-options');
  LENGTHS.forEach((l) => {
    lengthBox.append(el('label', { class: 'option' },
      el('input', { type: 'radio', name: 'years', value: String(l.years), checked: l.years === 3 }),
      el('div', { class: 'option-title', text: l.label })));
  });

  $('#start-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    state = createGame({
      name: form.get('name') || '',
      route: form.get('route'),
      years: Number(form.get('years')),
    });
    addLog(state, `🌸 ${ROUTES[state.route].name}で経理人生スタート！（全${state.totalYears}期）`);
    save();
    startGameScreen();
  });

  $('#continue-btn').addEventListener('click', () => {
    const saved = loadSave();
    if (!saved) return;
    state = saved;
    if (state.gameOver) showResult();
    else startGameScreen();
  });

  refreshContinue();
}

function refreshContinue() {
  const saved = loadSave();
  const btn = $('#continue-btn');
  btn.hidden = !saved || saved.gameOver;
  if (saved && !saved.gameOver) btn.textContent = `📂 つづきから（${saved.name}・第${saved.year}期）`;
}

function goTitle() {
  refreshContinue();
  showScreen('title-screen');
}

// ---------------------------------------------------------------- board

/** その月に入って最初のマス（手前のマスと月が違うマス） */
function monthStartIds() {
  const prevMonths = new Map(SQUARES.map((s) => [s.id, []]));
  for (const square of SQUARES) {
    if (square.stop) continue;
    for (const id of square.next) prevMonths.get(id).push(square.month);
  }
  return new Set(SQUARES.filter((s) => !prevMonths.get(s.id).includes(s.month)).map((s) => s.id));
}

function buildRoads(board) {
  const layer = svgEl('svg', {
    class: 'roads', viewBox: `0 0 ${BOARD_COLS} ${BOARD_ROWS}`, preserveAspectRatio: 'none', 'aria-hidden': 'true',
  });
  const base = svgEl('g', { class: 'road-base' });
  const walked = svgEl('g', { class: 'road-walked' });
  const center = svgEl('g', { class: 'road-center' });
  for (const square of SQUARES) {
    if (square.stop) continue; // 決算日→期首は線を引かない
    for (const id of square.next) {
      const [x1, y1] = square.at;
      const [x2, y2] = squareOf(id).at;
      const coords = { x1: x1 + 0.5, y1: y1 + 0.5, x2: x2 + 0.5, y2: y2 + 0.5 };
      base.append(svgEl('line', coords));
      center.append(svgEl('line', coords));
      const line = svgEl('line', coords);
      walked.append(line);
      roads.set(`${square.id}>${id}`, line);
    }
  }
  layer.append(base, walked, center);
  board.append(layer);
}

function buildBoard() {
  const board = $('#board');
  board.replaceChildren();
  board.style.setProperty('--cols', BOARD_COLS);
  board.style.setProperty('--rows', BOARD_ROWS);
  board.style.width = `${BOARD_COLS * UNIT}px`;
  board.style.height = `${BOARD_ROWS * UNIT}px`;
  cells = new Map();
  roads = new Map();
  board.append(...sides());
  buildRoads(board);

  for (const sign of SIGNS) {
    board.append(el('div', { class: 'sign', style: `--x: ${sign.at[0]}; --y: ${sign.at[1]}; --w: ${sign.width}` },
      el('div', { class: 'sign-title', text: sign.title }),
      sign.lanes.map((id) => el('div', { class: 'sign-lane', title: LANES[id].desc, text: `${LANES[id].icon} ${LANES[id].name}` }))));
  }

  const monthStarts = monthStartIds();
  for (const square of SQUARES) {
    let flag = null;
    if (square.branches) flag = '🔀 分かれ道';
    else if (square.id === START_ID) flag = 'START';
    else if (square.stop) flag = 'GOAL';
    const lane = square.lane ? LANES[square.lane] : null;
    const cell = el('div', {
      class: `cell t-${square.type}${lane ? ' lane' : ''}${square.branches ? ' fork' : ''}`,
      style: `--x: ${square.at[0]}; --y: ${square.at[1]}`,
      title: lane ? `${square.name}（${lane.name}）` : square.name,
    },
    sides(),
    el('div', { class: 'cell-face' },
      monthStarts.has(square.id) ? el('span', { class: 'cell-month', text: `${square.month}月` }) : null,
      el('span', { class: 'cell-icon', text: square.icon }),
      el('span', { class: 'cell-name', text: square.name }),
      square.note ? el('span', { class: 'cell-note', text: square.note }) : null,
      flag ? el('span', { class: 'cell-flag', text: flag }) : null));
    cells.set(square.id, cell);
    board.append(cell);
  }

  const legend = el('div', { class: 'legend' },
    [['work', '業務'], ['quiz', 'クイズ'], ['exam', '資格'], ['money', 'お金'], ['life', 'ライフ'], ['chance', 'チャンス'], ['trouble', 'ハプニング'], ['move', '進む・戻る'], ['rest', '休息'], ['stop', '必ず止まる']]
      .map(([type, name]) => el('span', { style: `--c: var(--t-${type})`, text: name })));
  $('.board-wrap').querySelector('.legend')?.remove();
  $('.board-wrap').append(legend);
}

/** 厚みを出すための側面（北・東・南・西） */
function sides() {
  return ['n', 'e', 's', 'w'].map((dir) => el('span', { class: `wall wall-${dir}`, 'aria-hidden': 'true' }));
}

/** 分かれ道で選ばなかったルート */
function skippedLanes(chosen) {
  const skipped = new Set();
  for (const square of SQUARES) {
    if (!square.branches || !square.branches.some((b) => chosen.includes(b.lane))) continue;
    for (const b of square.branches) if (!chosen.includes(b.lane)) skipped.add(b.lane);
  }
  return skipped;
}

function renderBoard() {
  const { trail, position } = state;
  const visited = new Set(trail);
  const walkedEdges = new Set(trail.slice(1).map((id, i) => `${trail[i]}>${id}`));
  const skipped = skippedLanes(lanesOnTrail(trail));
  for (const [id, cell] of cells) {
    const { lane } = squareOf(id);
    cell.classList.toggle('here', id === position);
    cell.classList.toggle('passed', visited.has(id) && id !== position);
    cell.classList.toggle('skipped', Boolean(lane && skipped.has(lane)));
    for (const node of cell.querySelectorAll('.token, .token-ring')) node.remove();
  }
  for (const [key, line] of roads) line.classList.toggle('walked', walkedEdges.has(key));
  cells.get(position).append(
    el('span', { class: 'token-ring', 'aria-hidden': 'true' }),
    el('span', { class: 'token', role: 'img', 'aria-label': 'あなたのコマ' },
      el('span', { class: 'token-head', text: '🧑‍💼' }),
      el('span', { class: 'token-stem' })),
  );
}

// ---------------------------------------------------------------- camera

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * 盤面を傾け・回して、注目点（コマ or 盤面の中心）が舞台の真ん中に来るように動かす。
 * instant ならトランジションなしで即座に反映する。
 */
function updateCamera({ instant = false } = {}) {
  const stage = $('#board-stage');
  const board = $('#board');
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (!width || !height) return;

  const boardW = BOARD_COLS * UNIT;
  const boardH = BOARD_ROWS * UNIT;
  let target = [boardW / 2, boardH / 2];
  let zoom;
  if (view.mode === 'overview' || !state) {
    // 回転後の外接矩形を、傾きで縦につぶした大きさに収める
    const spin = (view.spin * Math.PI) / 180;
    const [cos, sin] = [Math.abs(Math.cos(spin)), Math.abs(Math.sin(spin))];
    const fitW = boardW * cos + boardH * sin;
    const fitH = (boardW * sin + boardH * cos) * Math.cos((view.tilt * Math.PI) / 180) + 40;
    zoom = Math.min(width / fitW, height / fitH) * 0.8;
  } else {
    const [x, y] = squareOf(state.position).at;
    target = [(x + 0.5) * UNIT, (y + 0.5) * UNIT];
    zoom = clamp(width / 560, 0.55, 1.15);
  }

  board.classList.toggle('instant', instant);
  board.style.setProperty('--tilt', `${view.tilt}deg`);
  board.style.setProperty('--spin', `${view.spin}deg`);
  board.style.transform = `translate3d(${width / 2}px, ${height * 0.55}px, 0) scale3d(${zoom}, ${zoom}, ${zoom}) `
    + `rotateX(${view.tilt}deg) rotateZ(${view.spin}deg) translate3d(${-target[0]}px, ${-target[1]}px, 0)`;
  if (instant) {
    void board.offsetWidth; // 即時反映してからトランジションを戻す
    board.classList.remove('instant');
  }
  $('#view-toggle').textContent = view.mode === 'overview' ? '🧑‍💼 コマ' : '🗺️ 全体';
}

function setViewMode(mode) {
  view.mode = mode;
  view.tilt = VIEW_TILT[mode];
  updateCamera();
}

function setupCamera() {
  const stage = $('#board-stage');
  let drag = null;

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, spin: view.spin, tilt: view.tilt };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    view.spin = drag.spin + (e.clientX - drag.x) * 0.35;
    view.tilt = clamp(drag.tilt - (e.clientY - drag.y) * 0.25, ...TILT_RANGE);
    updateCamera();
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    view.spin = 0;
    setViewMode(view.mode);
  });

  $('#view-left').addEventListener('click', () => { view.spin -= 45; updateCamera(); });
  $('#view-right').addEventListener('click', () => { view.spin += 45; updateCamera(); });
  $('#view-reset').addEventListener('click', () => { view.spin = 0; setViewMode('follow'); });
  $('#view-toggle').addEventListener('click', () => setViewMode(view.mode === 'overview' ? 'follow' : 'overview'));

  new ResizeObserver(() => updateCamera({ instant: true })).observe(stage);
}

/** カメラでコマを追いかけ、盤面が画面の外ならスクロールする */
function followToken() {
  updateCamera();
  $('#board-stage').scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

// ---------------------------------------------------------------- status

function setBar(id, value, max) {
  $(id).style.width = `${Math.max(0, Math.min(100, (value / max) * 100))}%`;
}

function renderStatus() {
  const s = state;
  const rank = RANKS[s.rankIndex];
  const lane = currentLane(s);
  $('#period-label').replaceChildren(
    `第${s.year}期／全${s.totalYears}期`,
    el('small', { text: `${monthOf(s.position)}月・${lane ? `${lane.icon}${lane.name}・` : ''}${s.turn + 1}ターン目` }),
  );
  $('#st-name').textContent = s.name;
  $('#st-rank').textContent = `${rank.name}（${ROUTES[s.route].name}）`;
  const money = $('#st-money');
  money.textContent = formatYen(s.money);
  money.classList.toggle('negative', s.money < 0);
  $('#st-investment').textContent = formatYen(s.investment);
  $('#st-salary').textContent = `${formatYen(monthlySalary(s))}／${formatYen(livingCost(s))}`;

  $('#st-skill').textContent = s.skill;
  $('#st-trust').textContent = s.trust;
  $('#st-stress').textContent = s.stress;
  setBar('#bar-skill', s.skill, 200);
  setBar('#bar-trust', s.trust, 150);
  setBar('#bar-stress', s.stress, 100);
  $('#bar-stress').classList.toggle('danger', s.stress >= 80);

  const badges = [
    ...s.certs.map((id) => el('span', { class: 'badge', text: `🎓 ${CERTS[id].short}` })),
    s.married ? el('span', { class: 'badge', text: '💍 既婚' }) : null,
    s.children ? el('span', { class: 'badge', text: `👶 子ども${s.children}人` }) : null,
    s.house ? el('span', { class: 'badge', text: '🏡 マイホーム' }) : null,
    s.skipTurns ? el('span', { class: 'badge warn', text: `💤 ${s.skipTurns}回休み` }) : null,
    s.stress >= 80 ? el('span', { class: 'badge warn', text: '⚠️ ストレス限界間近' }) : null,
  ];
  $('#st-badges').replaceChildren(...badges.filter(Boolean));

  const next = RANKS[s.rankIndex + 1];
  let nextText = '🏆 最高役職に到達！';
  if (next) {
    const need = Math.max(0, next.threshold - evaluationPoints(s));
    const req = next.requires && !s.certs.includes(next.requires) ? `＋${CERTS[next.requires].short}が必要` : '';
    nextText = `次の役職「${next.name}」：評価pt ${evaluationPoints(s)}/${next.threshold}${need ? `（あと${need}）` : '（達成）'}${req}／判定補正 ＋${skillBonus(s)}`;
  }
  $('#st-next').textContent = nextText;

  const rollBtn = $('#roll-btn');
  rollBtn.textContent = s.skipTurns > 0 ? '💤 お休みする' : 'サイコロを振る';
  $('#dice-hint').textContent = s.skipTurns > 0 ? '1回休み中…' : 'スペースキーでも振れます';

  $('#log').replaceChildren(...s.log.slice(0, 40).map((entry) => el('li', {},
    el('span', { class: 'log-turn', text: `第${entry.year}期` }), entry.text)));
}

function render() {
  renderBoard();
  renderStatus();
}

// ---------------------------------------------------------------- modal

const STAT_LABELS = {
  money: '💴 所持金', investment: '📈 投資', skill: '📚 スキル', trust: '🤝 信頼', stress: '😵 ストレス',
};

function deltaNodes(deltas) {
  if (!deltas.length) return null;
  return el('div', { class: 'deltas' }, deltas.map((d) => {
    const good = d.key === 'stress' ? d.value < 0 : d.value > 0;
    const value = d.key === 'money' || d.key === 'investment'
      ? signedYen(d.value)
      : `${d.value > 0 ? '+' : ''}${d.value}`;
    return el('span', { class: `delta ${good ? 'up' : 'down'}`, text: `${STAT_LABELS[d.key]} ${value}` });
  }));
}

function rollNode(roll) {
  if (!roll) return null;
  return el('div', { class: `roll-box ${roll.success ? 'success' : 'failure'}` },
    el('span', { class: 'roll-dice', text: `🎲${roll.dice}` }),
    el('span', { text: `＋補正${roll.bonus} ＝ ${roll.total}（目標 ${roll.target}）` }),
    el('strong', { text: roll.success ? '成功' : '失敗' }));
}

function paragraphs(texts) {
  return texts.filter(Boolean).map((t) => el('p', { text: t }));
}

function openModal({ icon, title, body, actions }) {
  $('#modal-icon').textContent = icon ?? '📄';
  $('#modal-title').textContent = title ?? '';
  $('#modal-body').replaceChildren(...body.filter(Boolean));
  $('#modal-actions').replaceChildren(...actions);
  $('#modal').hidden = false;
  const first = $('#modal-actions').querySelector('button');
  first?.focus({ preventScroll: true });
}

function closeModal() {
  $('#modal').hidden = true;
}

function okButton(label, onClick) {
  return el('button', { type: 'button', class: 'btn btn-primary', text: label, onclick: onClick });
}

/** イベントを表示し、選択肢があれば選ばせる。適用された全変化量と、進む／戻るマス数を返す */
function runEvent(event, initialDeltas) {
  return new Promise((resolve) => {
    const collected = [...initialDeltas];
    const baseBody = [rollNode(event.roll), ...paragraphs(event.text), deltaNodes(initialDeltas)];

    if (!event.choices?.length) {
      openModal({
        icon: event.icon, title: event.title, body: baseBody,
        actions: [okButton('OK', () => { closeModal(); resolve({ deltas: collected, move: moveOf(event) }); })],
      });
      return;
    }

    const isQuiz = event.kind === 'quiz';
    const buttons = event.choices.map((choice, index) => el('button', {
      type: 'button',
      class: `choice-btn${isQuiz ? ' quiz' : ''}`,
      onclick: () => {
        const { outcome, deltas } = choose(state, event, index, rng);
        collected.push(...deltas);
        renderStatus();
        openModal({
          icon: event.icon, title: event.title,
          body: [
            ...(isQuiz ? paragraphs([event.text[0]]) : []),
            el('p', {}, el('strong', { text: `▶ ${choice.label}` })),
            el('hr', { class: 'divider' }),
            rollNode(outcome.roll),
            ...paragraphs(outcome.text),
            deltaNodes(deltas),
          ],
          actions: [okButton('OK', () => { closeModal(); resolve({ deltas: collected, move: moveOf(event, outcome) }); })],
        });
      },
    }, el('span', { class: 'choice-label', text: choice.label }), choice.note ? el('span', { class: 'choice-note', text: choice.note }) : null));

    openModal({ icon: event.icon, title: event.title, body: baseBody, actions: buttons });
  });
}

function showInfo({ icon, title, text }) {
  return runEvent({ icon, title, text }, []);
}

/** 分かれ道で進むルートを選ばせる。選んだルートの番号を返す */
function askBranch(square, remaining) {
  return new Promise((resolve) => {
    const buttons = square.branches.map((b, index) => el('button', {
      type: 'button',
      class: 'choice-btn branch-btn',
      onclick: () => { closeModal(); resolve(index); },
    },
    el('span', { class: 'choice-label', text: `${b.icon} ${b.name}（${b.length}マス）` }),
    el('span', { class: 'choice-note', text: b.desc }),
    el('span', { class: 'branch-preview', text: b.preview.join(' → ') })));
    openModal({
      icon: '🔀', title: '分かれ道',
      body: paragraphs([`「${square.name}」の先で道が分かれている。どちらのルートに進む？`, `（ここからあと ${remaining} マス進む）`]),
      actions: buttons,
    });
  });
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.hidden = false;
  toast.style.animation = 'none';
  void toast.offsetWidth; // アニメーションをリセット
  toast.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
}

function summarizeDeltas(deltas) {
  const total = {};
  for (const d of deltas) total[d.key] = (total[d.key] ?? 0) + d.value;
  return Object.entries(total)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${STAT_LABELS[k].split(' ')[0]}${k === 'money' || k === 'investment' ? signedYen(v) : (v > 0 ? `+${v}` : v)}`)
    .join(' ');
}

// ---------------------------------------------------------------- turn

/** 各面の目を 3×3 のどの位置に打つか */
const PIPS = {
  1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
};

/** その目を手前に向けるための回転（X, Y） */
const DICE_FACING = {
  1: [0, 0], 2: [-90, 0], 3: [0, -90], 4: [0, 90], 5: [90, 0], 6: [0, 180],
};

function buildDice() {
  $('#dice').replaceChildren(...Object.entries(PIPS).map(([value, pips]) => el('div', { class: `dice-face f${value}` },
    Array.from({ length: 9 }, (_, i) => (pips.includes(i)
      ? el('span', { class: 'pip', style: `grid-area: ${Math.floor(i / 3) + 1} / ${(i % 3) + 1}` })
      : null)))));
  setDice(1);
}

function applyDiceRotation() {
  $('#dice').style.transform = `rotateX(-22deg) rotateY(28deg) rotateX(${dice.x}deg) rotateY(${dice.y}deg)`;
}

/** 出目を手前に向ける（extraTurns 回分余計に転がす） */
function setDice(value, extraTurns = 0) {
  const [fx, fy] = DICE_FACING[value];
  const settle = (current, facing) => Math.ceil((current - facing) / 360 + extraTurns) * 360 + facing;
  dice.x = settle(dice.x, fx);
  dice.y = settle(dice.y, fy);
  applyDiceRotation();
  $('#dice').setAttribute('aria-label', `サイコロの目：${value}`);
}

async function animateDice() {
  const cube = $('#dice');
  cube.classList.add('rolling');
  for (let i = 0; i < 8; i += 1) {
    dice.x += 90 + Math.floor(rng() * 180);
    dice.y += 90 + Math.floor(rng() * 180);
    applyDiceRotation();
    await sleep(80);
  }
  cube.classList.remove('rolling');
  const value = rollDice(rng);
  setDice(value, 1);
  await sleep(500);
  return value;
}

/** steps マス進む（分かれ道ではルートを選ぶ）。止まるマスで途中停止したら true */
async function walkForward(steps) {
  for (let i = 0; i < steps; i += 1) {
    const square = squareOf(state.position);
    let branch = 0;
    if (square.branches) {
      branch = await askBranch(square, steps - i);
      const chosen = square.branches[branch];
      addLog(state, `🔀 ${chosen.icon} ${chosen.name}へ進んだ`);
    }
    const { payday } = stepTo(state, nextSquare(state.position, branch));
    renderBoard();
    followToken();
    if (payday) {
      showToast(`📅 ${payday.month}月の給料日！ 手取り${formatYen(payday.salary)} − 生活費${formatYen(payday.living)}`);
      addLog(state, `📅 ${payday.month}月の給料日 ${signedYen(payday.net)}`);
    }
    renderStatus();
    await sleep(STEP_MS);
    if (squareOf(state.position).stop) return i < steps - 1;
  }
  return false;
}

/** 通ってきた道を steps マス戻る。実際に戻ったマス数を返す */
async function walkBack(steps) {
  let moved = 0;
  while (moved < steps && moveBack(state, 1).length) {
    moved += 1;
    renderBoard();
    followToken();
    renderStatus();
    await sleep(STEP_MS);
  }
  return moved;
}

/**
 * 止まったマスのイベントを処理する。「進む／戻る」の移動先ではイベントは起きないが、
 * 決算日に着いたときだけは決算日のイベントを行う。
 */
async function resolveSquare(chained = false) {
  const { square, event, deltas } = openSquare(state, rng);
  renderStatus();
  const { deltas: all, move } = await runEvent(event, deltas);
  const summary = summarizeDeltas(all);
  addLog(state, `${square.icon} ${event.title}${summary ? `：${summary}` : ''}`);
  renderStatus();
  if (!move || chained) return;

  if (move < 0) {
    const moved = await walkBack(-move);
    const where = squareOf(state.position).name;
    const message = moved ? `⏪ ${moved}マス戻った（${where}）` : '⏪ 期首なのでこれ以上戻れない';
    addLog(state, message);
    showToast(message);
    return;
  }

  await walkForward(move);
  const landed = squareOf(state.position);
  addLog(state, `⏩ ${move}マス進んだ（${landed.name}）`);
  if (landed.stop) {
    showToast('🏁 決算日（3/31）に到着！');
    await resolveSquare(true);
  } else {
    showToast(`⏩ ${move}マス進んだ（${landed.name}）`);
  }
}

async function onRoll() {
  if (busy || !state || state.gameOver || !$('#modal').hidden) return;
  busy = true;
  $('#roll-btn').disabled = true;
  try {
    if (state.skipTurns > 0) {
      consumeSkip(state);
      addLog(state, '💤 1回休み');
      save();
      render();
      await showInfo({ icon: '💤', title: '1回休み', text: ['今回はお休み。ゆっくり体を休めよう。'] });
      return;
    }

    const steps = await animateDice();
    if (await walkForward(steps)) showToast('🏁 決算日（3/31）は必ずストップ！');
    await resolveSquare();

    const end = finishTurn(state);
    save();
    render();

    if (end.burnout) {
      addLog(state, '🤒 ストレスが限界に…1回休み');
      save();
      render();
      await showInfo({
        icon: '🤒', title: 'ストレスが限界に…',
        text: ['無理がたたって体調を崩してしまった。', '次のターンは1回休み。ストレスは60まで回復し、信頼が少し下がった。'],
      });
    }

    if (state.gameOver) {
      await sleep(300);
      showResult();
    }
  } finally {
    busy = false;
    $('#roll-btn').disabled = false;
  }
}

function startGameScreen() {
  buildBoard();
  render();
  showScreen('game-screen');
  updateCamera({ instant: true });
  followToken();
}

function openMenu() {
  if (busy) return;
  openModal({
    icon: '📋', title: 'メニュー',
    body: paragraphs(['進行状況はこのブラウザに自動保存されています。']),
    actions: [
      okButton('ゲームに戻る', closeModal),
      el('button', { type: 'button', class: 'btn btn-secondary', text: 'タイトルに戻る（保存して中断）', onclick: () => { closeModal(); save(); goTitle(); } }),
      el('button', {
        type: 'button', class: 'btn btn-secondary', text: 'データを消して最初から',
        onclick: () => {
          if (!window.confirm('セーブデータを削除して、タイトルに戻りますか？')) return;
          try { localStorage.removeItem(SAVE_KEY); } catch { /* noop */ }
          state = null;
          closeModal();
          goTitle();
        },
      }),
    ],
  });
}

// ---------------------------------------------------------------- result

function showResult() {
  const score = computeScore(state);
  $('#result-title').replaceChildren(
    el('span', { class: 'result-icon', text: score.title.icon }),
    score.title.name,
  );
  $('#result-comment').textContent = `${state.name}さん（${RANKS[state.rankIndex].name}）── ${score.title.comment}`;
  $('#score-body').replaceChildren(...score.items.map((item) => el('tr', {},
    el('th', { text: item.label }),
    el('td', { class: item.value < 0 ? 'negative' : '', text: `${item.value.toLocaleString('ja-JP')} pt` }))));
  $('#score-total').textContent = `${score.total.toLocaleString('ja-JP')} pt`;
  $('#history-body').replaceChildren(...state.history.map((h) => el('tr', {},
    el('td', { text: `第${h.year}期` }),
    el('td', { text: h.rank }),
    el('td', { class: 'lanes', text: (h.lanes ?? []).map((id) => `${LANES[id].icon}${LANES[id].short}`).join(' ') }),
    el('td', { text: String(h.points) }),
    el('td', { text: formatYen(h.money) }))));

  const q = state.quizStats;
  $('#result-extra').textContent = `仕訳クイズ正答率：${q.total ? Math.round((q.correct / q.total) * 100) : 0}%（${q.correct}/${q.total}）／総ターン数：${state.turn}`;

  const shareText = `経理人生ゲーム（全${state.totalYears}期）で「${score.title.name}」になりました！\n役職：${RANKS[state.rankIndex].name}／スコア：${score.total}pt\n#経理人生ゲーム`;
  const url = location.href.split('#')[0].split('?')[0];
  $('#share-btn').href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(url)}`;

  showScreen('result-screen');
}

// ---------------------------------------------------------------- init

function init() {
  setupTitle();
  setupCamera();
  buildDice();
  $('#roll-btn').addEventListener('click', onRoll);
  $('#menu-btn').addEventListener('click', openMenu);
  $('#restart-btn').addEventListener('click', () => {
    try { localStorage.removeItem(SAVE_KEY); } catch { /* noop */ }
    state = null;
    goTitle();
  });
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || $('#game-screen').hidden || !$('#modal').hidden) return;
    if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'BUTTON'].includes(e.target.tagName)) return;
    e.preventDefault();
    onRoll();
  });
  showScreen('title-screen');
}

init();
