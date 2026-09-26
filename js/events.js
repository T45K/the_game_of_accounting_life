// 盤面（分かれ道のあるすごろく）とイベント定義
//
// イベント: { title, icon, text: string[], effects?, apply?, move?, choices?: [{ label, note?, run(ctx) => Outcome }] }
// 結果  : { text: string[], effects?, apply?, roll?, move? }
// effects のキー: money / investment / skill / trust / stress（数値の増減）
// move: 正ならそのマス数だけ進む、負なら戻る（移動先のマスのイベントは発生しない。決算日だけは例外）
import {
  CERTS, CERT_ORDER, RANKS, OVERTIME_PAY, HOUSE_DOWN_PAYMENT, CHILD_LIVING_COST, HOUSE_LIVING_COST,
} from './constants.js';
import {
  skillBonus, isManager, formatYen, bonusAmount, bonusMonths, evaluationPoints,
  monthlySalary, livingCost,
} from './rules.js';
import { QUIZZES } from './quizzes.js';

// ---------------------------------------------------------------- helpers

export function mergeEffects(a = {}, b = {}) {
  const result = { ...a };
  for (const [key, value] of Object.entries(b)) result[key] = (result[key] ?? 0) + value;
  return result;
}

/** 判定：サイコロ + スキル補正 + extra ≧ target */
export function check(ctx, target, extra = 0) {
  const dice = ctx.dice();
  const bonus = skillBonus(ctx.state) + extra;
  const total = dice + bonus;
  return { dice, bonus, target, total, success: total >= target };
}

function checkOutcome(ctx, target, extra, success, failure) {
  const roll = check(ctx, target, extra);
  const res = roll.success ? success : failure;
  return {
    roll,
    text: [roll.success ? '✅ 成功！' : '❌ 失敗…', ...[].concat(res.text)],
    effects: { ...res.effects },
    apply: res.apply,
    move: res.move,
  };
}

/** 「通常対応」「残業して全力対応」の2択で判定する業務イベントの選択肢 */
function workChoices({ target, success, failure, overtimeStress = 10 }) {
  return [
    {
      label: '通常どおり対応する',
      note: `判定：🎲＋スキル補正 ≧ ${target}`,
      run: (ctx) => checkOutcome(ctx, target, 0, success, failure),
    },
    {
      label: '残業して全力で取り組む',
      note: `判定＋2／ストレス＋${overtimeStress}`,
      run: (ctx) => {
        const o = checkOutcome(ctx, target, 2, success, failure);
        o.effects = mergeEffects(o.effects, { stress: overtimeStress });
        if (isManager(ctx.state)) {
          o.text.push('（管理職なので残業代は出ない…）');
        } else {
          o.effects = mergeEffects(o.effects, { money: OVERTIME_PAY });
          o.text.push(`（残業代 ${formatYen(OVERTIME_PAY)} が出た）`);
        }
        return o;
      },
    },
  ];
}

function workEvent({ title, icon, text, ...rest }) {
  return () => ({ title, icon, text, choices: workChoices(rest) });
}

function simpleEvent(title, icon, text, effects = {}) {
  return () => ({ title, icon, text, effects });
}

// ---------------------------------------------------------------- quiz

function drawQuiz(ctx) {
  const s = ctx.state;
  let available = QUIZZES.map((_, i) => i).filter((i) => !s.usedQuiz.includes(i));
  if (available.length === 0) {
    s.usedQuiz = [];
    available = QUIZZES.map((_, i) => i);
  }
  const index = ctx.pick(available);
  s.usedQuiz.push(index);
  return QUIZZES[index];
}

function quizEvent(title = '仕訳クイズ') {
  return (ctx) => {
    const quiz = drawQuiz(ctx);
    const order = ctx.shuffle(quiz.choices.map((_, i) => i));
    return {
      title, icon: '✏️', kind: 'quiz',
      text: [quiz.q, '正しいものを選ぼう。'],
      choices: order.map((i) => ({
        label: quiz.choices[i],
        run: () => (i === quiz.answer
          ? {
            text: ['⭕ 正解！', quiz.explain],
            effects: { skill: 3, trust: 1 },
            apply: (s) => { s.quizStats.total += 1; s.quizStats.correct += 1; },
          }
          : {
            text: ['❌ 不正解…', `正解：${quiz.choices[quiz.answer]}`, quiz.explain],
            effects: { skill: 1, stress: 3 },
            apply: (s) => { s.quizStats.total += 1; },
          }),
      })),
    };
  };
}

// ---------------------------------------------------------------- exam

function examOutcome(ctx, cert, extra) {
  const roll = check(ctx, cert.target, extra);
  if (roll.success) {
    return {
      roll,
      text: [
        `🎉 ${cert.name}に合格！`,
        cert.allowance ? `資格手当として毎月 ${formatYen(cert.allowance)} が支給されることになった。` : '経理パーソンとしての基礎が固まった！',
      ],
      effects: { money: -cert.fee, skill: 10, trust: 5 },
      apply: (s) => { if (!s.certs.includes(cert.id)) s.certs.push(cert.id); },
    };
  }
  return {
    roll,
    text: ['😢 不合格…。', 'でも勉強した知識はしっかり身についた。次こそ！'],
    effects: { money: -cert.fee, skill: 4, stress: 5 },
  };
}

function examEvent(month) {
  return (ctx) => {
    const s = ctx.state;
    const title = `日商簿記検定（${month}月）`;
    const nextId = CERT_ORDER.find((id) => !s.certs.includes(id));
    if (!nextId) {
      return {
        title, icon: '🎓',
        text: ['簿記は1級まで取得済み！', '今回は後輩の受験勉強を全力でサポートした。'],
        effects: { trust: 5, skill: 2 },
      };
    }
    const cert = CERTS[nextId];
    if (nextId === 'boki1' && month === 2) {
      return {
        title, icon: '🎓',
        text: ['2月の統一試験では1級は実施されない（1級は6月・11月のみ）。', '次の1級に向けて、商業簿記・会計学の勉強を進めた。'],
        effects: { skill: 4, stress: 3 },
      };
    }
    return {
      title, icon: '🎓', kind: 'exam',
      text: [
        `${cert.name}の試験日がやってきた。`,
        `合格条件：🎲＋スキル補正（いま＋${skillBonus(s)}） ≧ ${cert.target}`,
        cert.allowance ? `合格すると資格手当 月${formatYen(cert.allowance)}！` : '',
      ].filter(Boolean),
      choices: [
        { label: '受験する', note: `受験料 ${cert.fee.toLocaleString('ja-JP')}円`, run: (c) => examOutcome(c, cert, 0) },
        {
          label: '猛勉強して受験する',
          note: '判定＋2／ストレス＋15',
          run: (c) => {
            const o = examOutcome(c, cert, 2);
            o.effects = mergeEffects(o.effects, { stress: 15 });
            return o;
          },
        },
        { label: '今回は見送る', note: 'ストレス−5', run: () => ({ text: ['今回は見送り。次の試験に向けて英気を養おう。'], effects: { stress: -5 } }) },
      ],
    };
  };
}

// ---------------------------------------------------------------- bonus

function bonusEvent(season) {
  return (ctx) => {
    const s = ctx.state;
    const amount = bonusAmount(s);
    const half = Math.round(amount / 2 / 1000) * 1000;
    const treat = Math.round(amount * 0.3 / 1000) * 1000;
    return {
      title: `${season}の賞与`, icon: '💰', kind: 'money',
      text: [
        `賞与が支給された！（基本給の${bonusMonths(s).toFixed(1)}か月分・信頼が高いほど増える）`,
        `支給額：${formatYen(amount)}　使い道はどうする？`,
      ],
      effects: { money: amount },
      choices: [
        { label: '堅実に貯金する', note: '所持金はそのまま', run: () => ({ text: ['コツコツ貯金。将来の自分がきっと感謝する。'] }) },
        {
          label: '半分を新NISAで積立投資',
          note: `投資 ${formatYen(half)}（毎期末に運用成績が変動）`,
          run: () => ({ text: ['長期・積立・分散。運用成績は期末に判明する。'], effects: { money: -half, investment: half } }),
        },
        {
          label: '自分へのご褒美に使う',
          note: `所持金 −${formatYen(treat)}／ストレス−20`,
          run: () => ({ text: ['欲しかったものを買って気分はリフレッシュ！'], effects: { money: -treat, stress: -20 } }),
        },
      ],
    };
  };
}

// ---------------------------------------------------------------- random pools

const CHANCE_EVENTS = [
  simpleEvent('上司に褒められた', '👏', ['月次決算の早期化に貢献したと、部長から直々に褒められた！'], { trust: 6 }),
  simpleEvent('RPA導入に成功', '🤖', ['入金の消込作業をRPAで自動化。チーム全体の残業が減った！'], { skill: 5, trust: 4, stress: -8 }),
  simpleEvent('社内表彰', '🏅', ['業務改善提案が「社長賞」に選ばれた！報奨金をもらった。'], { money: 30000, trust: 6 }),
  simpleEvent('電子帳簿保存法対応', '🗂️', ['電子取引データの保存ルールを整備し、ペーパーレス化をリードした。'], { skill: 5, trust: 4 }),
  simpleEvent('ふるさと納税の返礼品', '🦀', ['ふるさと納税の返礼品が届いた。ワンストップ特例の申請書も忘れずに。'], { stress: -8 }),
  simpleEvent('経理の勉強会', '📚', ['他社の経理担当者との勉強会に参加。連結決算の効率化ノウハウを学んだ。'], { skill: 5, trust: 2 }),
  simpleEvent('ノー残業デー', '🌇', ['今日は全社ノー残業デー。定時で帰ってのんびり過ごした。'], { stress: -12 }),
  simpleEvent('監査法人と意気投合', '🤝', ['監査法人の担当者と会計論点について議論が盛り上がり、信頼関係ができた。'], { trust: 4, skill: 2 }),
  () => ({
    title: '月次決算の早期化', icon: '⏩',
    text: ['月次決算を3営業日早く締められるようになった！', '⏩ 2マス進む'],
    effects: { trust: 3 },
    move: 2,
  }),
  (ctx) => {
    const win = ctx.dice() === 6;
    return {
      title: '宝くじ', icon: '🎫',
      text: win ? ['年末ジャンボ…ではないけど、スクラッチで1万円当たった！'] : ['スクラッチで300円当たった。（買ったのは300円）'],
      effects: win ? { money: 10000, stress: -5 } : { stress: -1 },
    };
  },
  () => ({
    title: '経費精算システム刷新', icon: '💻',
    text: ['新しい経費精算システムの導入プロジェクトに誘われた。'],
    choices: [
      { label: 'リーダーに立候補する', note: 'スキル＋6／信頼＋5／ストレス＋10', run: () => ({ text: ['プロジェクトは大成功！社内の評価がぐっと上がった。'], effects: { skill: 6, trust: 5, stress: 10 } }) },
      { label: 'メンバーとして参加する', note: 'スキル＋3／信頼＋2', run: () => ({ text: ['着実に貢献した。新システムにも詳しくなった。'], effects: { skill: 3, trust: 2 } }) },
    ],
  }),
];

const TROUBLE_EVENTS = [
  simpleEvent('請求書が行方不明', '📄', ['支払予定の請求書が見当たらない…。取引先に再発行をお願いした。'], { stress: 8, trust: -1 }),
  simpleEvent('期限切れの経費精算', '🧾', ['営業部から3か月前の経費精算がまとめて届いた。領収書はレシートの束…。'], { stress: 10 }),
  simpleEvent('システム障害', '💥', ['会計システムの障害で仕訳が二重計上に。原因調査と修正に追われた。'], { stress: 10, skill: 2 }),
  simpleEvent('インボイスの不備', '🔢', ['受け取った請求書に登録番号の記載がない！仕入税額控除のため取引先に確認した。'], { stress: 5, skill: 2 }),
  simpleEvent('マクロが動かない', '📊', ['前任者が作った謎のExcelマクロがエラーに。誰も中身を知らない…。'], { stress: 8, skill: 3 }),
  (ctx) => {
    const n = Math.ceil(ctx.dice() / 2);
    return {
      title: '稟議の差し戻し', icon: '↩️',
      text: ['支払稟議に見積書の添付漏れがあり、差し戻されてしまった…。', `⏪ ${n}マス戻る（🎲÷2）`],
      effects: { stress: 5 },
      move: -n,
    };
  },
  (ctx) => {
    const roll = check(ctx, 4);
    return {
      title: '振込ミスの危機', icon: '🏦', roll,
      text: roll.success
        ? ['✅ 振込データの口座番号の誤りに、ダブルチェックで気づいた！未然に防げた。']
        : ['❌ 振込先の口座番号を間違えて送金してしまった…。組戻しの手続きに奔走。'],
      effects: roll.success ? { trust: 3, skill: 1 } : { trust: -4, stress: 12 },
    };
  },
  (ctx) => {
    const roll = check(ctx, 4);
    return {
      title: '怪しい請求書メール', icon: '🎣', roll,
      text: roll.success
        ? ['✅ 「振込先変更のお知らせ」…これはビジネスメール詐欺だ！見抜いて社内に注意喚起した。']
        : ['❌ 危うく偽の請求書に支払うところだった。上司が気づいて事なきを得たが、大目玉…。'],
      effects: roll.success ? { trust: 5 } : { trust: -5, stress: 10 },
    };
  },
  () => ({
    title: '明日の朝までに資料を！', icon: '⏰',
    text: ['夕方6時、部長から「明日の役員会用に部門別損益を出してほしい」と依頼が…。'],
    choices: [
      { label: '徹夜で仕上げる', note: '信頼＋6／ストレス＋15', run: () => ({ text: ['なんとか間に合った。部長は満足げだ。'], effects: { trust: 6, stress: 15 } }) },
      { label: '明日の午後まで待ってもらう', note: '信頼−3', run: () => ({ text: ['交渉して期限を延ばしてもらった。無理は禁物。'], effects: { trust: -3, stress: 2 } }) },
    ],
  }),
  () => ({
    title: 'インフルエンザ', icon: '🤒',
    text: ['高熱でダウン…。1回休み。', 'しっかり休んでストレスは少し回復した。'],
    effects: { stress: -10 },
    apply: (s) => { s.skipTurns += 1; },
  }),
];

const LIFE_EVENTS = [
  {
    when: (s) => !s.married,
    event: () => ({
      title: '運命の出会い', icon: '💍',
      text: ['友人の紹介で素敵な人と出会った。交際は順調。', 'そろそろ結婚を考える…？'],
      choices: [
        {
          label: '結婚する！',
          note: '所持金−50万円／ストレス−15',
          run: () => ({
            text: ['おめでとう！挙式と新生活でお金はかかったけれど、幸せいっぱい。', '（ご祝儀の管理は家計簿でしっかりと）'],
            effects: { money: -500000, stress: -15, trust: 3 },
            apply: (s) => { s.married = true; },
          }),
        },
        { label: '今は仕事に集中する', note: 'スキル＋3', run: () => ({ text: ['…今は仕事が恋人。'], effects: { skill: 3 } }) },
      ],
    }),
  },
  {
    when: (s) => s.married && s.children < 3,
    event: () => ({
      title: '赤ちゃん誕生', icon: '👶',
      text: [
        '家族が増えた！出産育児一時金（50万円）で出産費用はほぼまかなえた。',
        `これから生活費が毎月 ${formatYen(CHILD_LIVING_COST)} 増える。`,
      ],
      effects: { money: -50000 },
      apply: (s) => { s.children += 1; },
      choices: [
        { label: '育休を取得する', note: '1回休み／ストレス−25', run: () => ({ text: ['チームが快く送り出してくれた。家族との大切な時間。'], effects: { stress: -25, trust: 2 }, apply: (s) => { s.skipTurns += 1; } }) },
        { label: 'すぐに職場復帰する', note: '信頼＋3／ストレス＋10', run: () => ({ text: ['決算期が近いので早めに復帰。無理はしないように…。'], effects: { trust: 3, stress: 10 } }) },
      ],
    }),
  },
  {
    when: (s) => !s.house,
    event: (ctx) => {
      if (ctx.state.money < HOUSE_DOWN_PAYMENT) {
        return {
          title: 'モデルルーム見学', icon: '🏠',
          text: ['週末にモデルルームを見学した。', `頭金 ${formatYen(HOUSE_DOWN_PAYMENT)} が貯まったら考えよう。`],
          effects: { stress: -3 },
        };
      }
      return {
        title: 'マイホーム購入のチャンス', icon: '🏡',
        text: ['理想の物件が見つかった！', `頭金 ${formatYen(HOUSE_DOWN_PAYMENT)}、以後の生活費がローン返済で毎月 ${formatYen(HOUSE_LIVING_COST)} 増える。`, '年末調整では住宅ローン控除が受けられるかも。'],
        choices: [
          { label: '購入する', note: `所持金−${formatYen(HOUSE_DOWN_PAYMENT)}／ストレス−10`, run: () => ({ text: ['念願のマイホーム！人生の資産が一つ増えた。'], effects: { money: -HOUSE_DOWN_PAYMENT, stress: -10 }, apply: (s) => { s.house = true; } }) },
          { label: '今回は見送る', note: '変化なし', run: () => ({ text: ['焦らずじっくり考えよう。'] }) },
        ],
      };
    },
  },
  {
    when: () => true,
    event: simpleEvent('同窓会', '🎉', ['久しぶりの同窓会。「経理って何してるの？」と聞かれ、熱く語ってしまった。'], { money: -10000, stress: -8 }),
  },
  {
    when: () => true,
    event: simpleEvent('引っ越し', '📦', ['引っ越しをした。敷金精算書の原状回復費用を細かくチェックしてしまうのは職業病。'], { money: -200000, stress: -5 }),
  },
  {
    when: () => true,
    event: (ctx) => {
      const good = ctx.dice() >= 3;
      return {
        title: '健康診断', icon: '🩺',
        text: good ? ['結果はオールA！決算期に向けて体調は万全だ。'] : ['再検査の通知が…。生活習慣を見直そう。'],
        effects: good ? { stress: -5 } : { stress: 6, money: -10000 },
      };
    },
  },
  {
    when: () => true,
    event: () => ({
      title: '資格スクールの案内', icon: '🏫',
      text: ['資格スクールから「簿記講座」の案内が届いた。'],
      choices: [
        { label: '受講する', note: '所持金−15万円／スキル＋10', run: () => ({ text: ['プロの講義はやっぱりわかりやすい！'], effects: { money: -150000, skill: 10, stress: 3 } }) },
        { label: '独学でがんばる', note: 'スキル＋3', run: () => ({ text: ['テキストと過去問で地道に勉強。'], effects: { skill: 3 } }) },
      ],
    }),
  },
  {
    when: () => true,
    event: () => ({
      title: 'ペットを飼う？', icon: '🐈',
      text: ['保護猫の譲渡会で、運命の子と目が合った。'],
      choices: [
        { label: '家族に迎える', note: '所持金−10万円／ストレス−20', run: () => ({ text: ['帰宅するのが毎日楽しみになった。'], effects: { money: -100000, stress: -20 } }) },
        { label: '今回は見送る', note: '変化なし', run: () => ({ text: ['また今度会いに来よう。'] }) },
      ],
    }),
  },
  {
    when: () => true,
    event: () => ({
      title: '副業の相談', icon: '💼',
      text: ['知人の個人事業主から「記帳代行を手伝ってほしい」と頼まれた。（会社の副業申請は通っている）'],
      choices: [
        { label: '引き受ける', note: '所持金＋8万円／スキル＋3／ストレス＋8', run: () => ({ text: ['青色申告決算書まで仕上げて感謝された。'], effects: { money: 80000, skill: 3, stress: 8 } }) },
        { label: '断る', note: 'ストレス−3', run: () => ({ text: ['本業に集中しよう。'], effects: { stress: -3 } }) },
      ],
    }),
  },
];

function pickPoolEvent(pool) {
  return (ctx) => ctx.pick(pool)(ctx);
}

function lifeEvent(ctx) {
  const candidates = LIFE_EVENTS.filter((e) => e.when(ctx.state));
  return ctx.pick(candidates).event(ctx);
}

// ---------------------------------------------------------------- 決算日

export function promotionResult(state) {
  const points = evaluationPoints(state);
  let index = state.rankIndex;
  let blockedBy = null;
  let promotions = 0;
  while (index + 1 < RANKS.length && promotions < 2) {
    const next = RANKS[index + 1];
    if (points < next.threshold) break;
    if (next.requires && !state.certs.includes(next.requires)) {
      blockedBy = next;
      break;
    }
    index += 1;
    promotions += 1;
  }
  return { points, from: state.rankIndex, to: index, blockedBy };
}

function closingEvent(ctx) {
  const s = ctx.state;
  const pay = monthlySalary(s) - livingCost(s);
  const text = [`いよいよ第${s.year}期の決算日。ここからが経理の本番…！`, `3月分の給料日：手取り ${formatYen(monthlySalary(s))} − 生活費 ${formatYen(livingCost(s))}`];

  let investmentDelta = 0;
  if (s.investment > 0) {
    const rate = -0.1 + ctx.rng() * 0.35;
    investmentDelta = Math.round(s.investment * rate);
    text.push(`📈 新NISAの運用成績：${rate >= 0 ? '+' : ''}${(rate * 100).toFixed(1)}%`);
  }

  const promo = promotionResult(s);
  text.push(`📋 期末評価ポイント（スキル＋信頼）：${promo.points}pt`);
  if (promo.to > promo.from) {
    text.push(`🎊 昇進！ ${RANKS[promo.from].name} → ${RANKS[promo.to].name}`);
  } else if (promo.blockedBy) {
    text.push(`😣 ${promo.blockedBy.name}への昇進には${CERTS[promo.blockedBy.requires].name}が必要…。`);
  } else if (promo.to + 1 < RANKS.length) {
    const next = RANKS[promo.to + 1];
    text.push(`次の役職「${next.name}」まであと ${next.threshold - promo.points}pt。`);
  } else {
    text.push('CFOとして会社の財務を率いている。');
  }

  const isLast = s.year >= s.totalYears;
  text.push(isLast ? '🏁 最終期の決算日を迎えた。人生の決算報告へ！' : `🌸 次は第${s.year + 1}期。新年度がはじまる！`);

  return {
    title: `第${s.year}期 決算日（3/31）`, icon: '🏁', kind: 'closing',
    text,
    effects: { money: pay, investment: investmentDelta },
    apply: (st) => {
      st.rankIndex = promo.to;
      st.history.push({
        year: st.year,
        rank: RANKS[promo.to].name,
        points: promo.points,
        money: st.money,
        investment: st.investment,
        lanes: lanesOnTrail(st.trail),
      });
      if (isLast) st.gameOver = true;
      else st.year += 1;
    },
  };
}


// ---------------------------------------------------------------- 盤面

const sq = (month, name, icon, type, event, extra = {}) => ({ month, name, icon, type, event, ...extra });

/** 分かれ道の先のルート（キーはセグメント id） */
export const LANES = {
  disclosure: { name: '開示ルート', short: '開示', icon: '📘', desc: '有報・株主総会・IR。ハードだがスキルと信頼が大きく伸びる。' },
  tax: { name: '税務・労務ルート', short: '税務', icon: '🧾', desc: '6月の簿記検定に挑戦できる。チャンスマスもあって堅実。' },
  project: { name: 'プロジェクトルート', short: 'PJ', icon: '🚀', desc: 'システム導入やM&A。大きく伸びるが、失敗すると戻されることも。' },
  routine: { name: '定常業務ルート', short: '定常', icon: '🗃️', desc: '監査対応などの堅実な業務。有給休暇で一息つける。' },
  planning: { name: '経営企画ルート', short: '経企', icon: '🧭', desc: '予算・取締役会・中計。経営陣の信頼を得るチャンス。' },
  study: { name: '資格・学習ルート', short: '資格', icon: '📚', desc: '2月の簿記検定に挑戦。勉強してスキルを磨く。' },
};

/**
 * 道（セグメント）。マスは盤面の (x, y) から dir 方向に1マスずつ並ぶ（盤面は 8×9 マス）。
 * 最後のマスは next のセグメントの先頭につながり、next が2つあれば分かれ道になる。
 */
const SEGMENTS = [
  {
    id: 'a', x: 0, y: 0, dir: 1, next: ['disclosure', 'tax'],
    squares: [
      sq(4, '新年度スタート', '🌸', 'rest', (ctx) => ({
        title: `第${ctx.state.year}期スタート`, icon: '🌸',
        text: ['新しい期が始まった！前期の決算整理も待っている。', '今期の目標は？'],
        choices: [
          { label: 'スキルアップ', note: 'スキル＋5', run: () => ({ text: ['今期は専門性を磨く！'], effects: { skill: 5 } }) },
          { label: 'チームワーク', note: '信頼＋5', run: () => ({ text: ['今期は周りを巻き込んでいく！'], effects: { trust: 5 } }) },
          { label: 'ワークライフバランス', note: 'ストレス−10', run: () => ({ text: ['今期は無理せず、メリハリをつける！'], effects: { stress: -10 } }) },
        ],
      }), { note: '4/1' }),
      sq(4, '決算整理仕訳', '📝', 'quiz', quizEvent('決算整理仕訳クイズ')),
      sq(4, '期末監査', '🔍', 'work', workEvent({
        title: '監査法人の期末監査', icon: '🔍',
        text: ['監査法人の期末監査がスタート。会計士から質問リストが山のように届く…。'],
        target: 5,
        success: { text: '的確な回答と資料準備で、監査はスムーズに進んだ。', effects: { skill: 4, trust: 4, stress: 5 } },
        failure: { text: '引当金の見積りについて修正を指摘されてしまった…。', effects: { skill: 2, trust: -3, stress: 10 } },
      })),
      sq(4, '新入社員歓迎会', '🍻', 'rest', () => ({
        title: '新入社員歓迎会', icon: '🍻',
        text: ['経理部にも新入社員がやってきた。今夜は歓迎会！'],
        choices: [
          { label: '参加して盛り上げる', note: '会費5,000円／信頼＋4／ストレス−5', run: () => ({ text: ['新人さんとも打ち解けた。'], effects: { money: -5000, trust: 4, stress: -5 } }) },
          { label: '早めに帰って勉強する', note: 'スキル＋3', run: () => ({ text: ['自宅で税効果会計を復習した。'], effects: { skill: 3 } }) },
        ],
      })),
      sq(5, '決算短信の開示', '📢', 'work', workEvent({
        title: '決算短信の開示', icon: '📢',
        text: ['決算日後45日以内の開示が求められる決算短信。数字の最終チェックだ！'],
        target: 6,
        success: { text: '無事に開示完了！IR担当からも感謝された。', effects: { skill: 3, trust: 6, stress: 8 } },
        failure: { text: '開示後に数字の誤りが発覚し、訂正開示…。胃が痛い。', effects: { trust: -5, stress: 15 } },
      }), { note: '〜5/15頃' }),
      sq(5, '仕訳クイズ', '✏️', 'quiz', quizEvent()),
      sq(5, 'GW明けの経費精算', '🧾', 'trouble', simpleEvent('GW明けの経費精算ラッシュ', '🧾', ['連休中の出張精算が一気に届いた。領収書の山！', 'インボイスの登録番号も一枚ずつ確認…。'], { stress: 8, skill: 2 })),
      sq(5, '法人税等の確定申告', '🏛️', 'work', workEvent({
        title: '法人税・消費税の確定申告', icon: '🏛️',
        text: ['3月決算法人の申告・納付期限は原則5月31日。申告書の作成と納付を進める。', '（申告期限の延長特例を使っても、納付が遅れると利子税がかかる）'],
        target: 6,
        success: { text: '申告書を期限内に提出し、納付も完了！', effects: { skill: 5, trust: 4, stress: 8 } },
        failure: { text: '別表の転記ミスが見つかり、修正申告をすることに…。', effects: { skill: 2, trust: -4, stress: 12 } },
      }), { note: '5/31' }),
    ],
  },
  // ---- 分かれ道①（6〜7月）
  {
    id: 'disclosure', x: 6, y: 1, dir: -1, next: ['b'],
    squares: [
      sq(6, '有価証券報告書', '📗', 'work', workEvent({
        title: '有価証券報告書の作成', icon: '📗',
        text: ['事業年度経過後3か月以内（6月末）に有価証券報告書を提出する。注記も含めると100ページ超…！'],
        target: 6,
        success: { text: 'EDINETで無事に提出！開示のプロに一歩近づいた。', effects: { skill: 6, trust: 6, stress: 10 } },
        failure: { text: '監査法人のレビューで記載漏れが多数…。連日の深夜作業に。', effects: { skill: 3, trust: -4, stress: 15 } },
      }), { note: '6/30' }),
      sq(6, '定時株主総会', '🎤', 'work', () => ({
        title: '定時株主総会', icon: '🎤',
        text: ['6月下旬は定時株主総会。想定問答集づくりに駆り出された！'],
        choices: [
          { label: '想定問答を作り込む', note: 'スキル＋2／信頼＋6／ストレス＋8', run: () => ({ text: ['株主の質問にも役員がスムーズに回答できた。'], effects: { skill: 2, trust: 6, stress: 8 } }) },
          {
            label: '昨年の資料を流用する', note: '運しだい',
            run: (ctx) => (ctx.dice() >= 4
              ? { text: ['特に問題なく総会は終了。ラッキー！'], effects: { trust: 1, stress: -2 } }
              : { text: ['株主から想定外の質問が…。役員の視線が痛い。'], effects: { trust: -4, stress: 6 } }),
          },
        ],
      }), { note: '下旬' }),
      sq(7, 'IR説明会', '🎙️', 'work', workEvent({
        title: '決算説明会（IR）の準備', icon: '🎙️',
        text: ['機関投資家向けの決算説明会。説明資料と想定Q&Aを準備する。'],
        target: 5,
        success: { text: '「数字の説明が分かりやすい」と投資家から好評！', effects: { skill: 4, trust: 7, stress: 6 } },
        failure: { text: 'セグメント利益の質問に役員が詰まってしまった…。', effects: { trust: -3, stress: 10 } },
      })),
    ],
  },
  {
    id: 'tax', x: 7, y: 2, dir: -1, next: ['b'],
    squares: [
      sq(6, '簿記検定（6月）', '🎓', 'exam', examEvent(6)),
      sq(6, '労働保険の年度更新', '📋', 'work', simpleEvent('労働保険の年度更新', '📋', ['6/1〜7/10は労働保険の年度更新。確定保険料と概算保険料を計算して申告する。', '6月からは住民税の特別徴収額も切り替わる。'], { skill: 3, stress: 5 }), { note: '〜7/10' }),
      sq(7, '算定基礎届', '📋', 'work', simpleEvent('算定基礎届', '📋', ['7/1〜7/10は算定基礎届の提出期間。4〜6月の報酬から標準報酬月額を決める。'], { skill: 3, stress: 4 }), { note: '〜7/10' }),
      sq(7, 'チャンス', '🍀', 'chance', pickPoolEvent(CHANCE_EVENTS)),
    ],
  },
  {
    id: 'b', x: 3, y: 2, dir: -1, next: ['c'],
    squares: [
      sq(7, '第1四半期決算', '📊', 'work', workEvent({
        title: '第1四半期決算', icon: '📊',
        text: ['6月末で第1四半期の締め。年度決算が終わったばかりなのに、もう次の決算…！'],
        target: 5,
        success: { text: 'テンプレートを整備していたおかげで効率よく締められた。', effects: { skill: 4, trust: 3, stress: 5 } },
        failure: { text: '子会社からの報告が遅れ、スケジュールがギリギリに…。', effects: { trust: -2, stress: 10 } },
      })),
      sq(7, '夏の賞与', '💰', 'money', bonusEvent('夏')),
      sq(8, '夏休み', '🏖️', 'rest', () => ({
        title: '夏休み', icon: '🏖️',
        text: ['待ちに待った夏休み！どう過ごす？'],
        choices: [
          { label: '旅行に行く', note: '所持金−8万円／ストレス−30', run: () => ({ text: ['海でリフレッシュ！仕事のことは忘れた。'], effects: { money: -80000, stress: -30 } }) },
          { label: '家でのんびり', note: 'ストレス−15', run: () => ({ text: ['積んでいた本を読んで過ごした。'], effects: { stress: -15 } }) },
          { label: '簿記の勉強合宿', note: 'スキル＋8／ストレス−5', run: () => ({ text: ['過去問を一気に解いた。充実感！'], effects: { skill: 8, stress: -5 } }) },
        ],
      })),
      sq(8, 'Q1決算短信', '📢', 'work', workEvent({
        title: '第1四半期決算短信', icon: '📢',
        text: ['8月中旬までに第1四半期決算短信を開示する。'],
        target: 5,
        success: { text: '期限内に開示完了！', effects: { skill: 3, trust: 4, stress: 5 } },
        failure: { text: 'セグメント情報の集計ミスで差し替え作業に追われた…。', effects: { trust: -3, stress: 10 } },
      }), { note: '〜8/14頃' }),
    ],
  },
  {
    id: 'c', x: 0, y: 3, dir: 1, next: ['project', 'routine'],
    squares: [
      sq(8, '仕訳クイズ', '✏️', 'quiz', quizEvent()),
      sq(8, 'ハプニング', '⚡', 'trouble', pickPoolEvent(TROUBLE_EVENTS)),
      sq(8, 'ライフイベント', '💞', 'life', lifeEvent),
      sq(9, '予算実績管理', '📈', 'work', () => ({
        title: '予算実績管理', icon: '📈',
        text: ['上期の着地見込みを作成する。営業部門との数字のすり合わせが必要だ。'],
        choices: [
          { label: '各部門を回ってヒアリング', note: '信頼＋5／ストレス＋5', run: () => ({ text: ['現場の実感がこもった見込みができた。'], effects: { trust: 5, stress: 5 } }) },
          { label: 'Excelを駆使して一人で仕上げる', note: 'スキル＋5／ストレス＋5', run: () => ({ text: ['ピボットテーブルとXLOOKUPが火を噴いた。'], effects: { skill: 5, stress: 5 } }) },
        ],
      })),
      sq(9, 'チャンス', '🍀', 'chance', pickPoolEvent(CHANCE_EVENTS)),
      sq(9, '固定資産の実査', '🏭', 'work', (ctx) => {
        const found = ctx.dice() % 2 === 0;
        return {
          title: '固定資産の実査', icon: '🏭',
          text: ['固定資産台帳と現物を突き合わせる。', found ? '倉庫の奥で、廃棄済みなのに台帳に残っているサーバーを発見！除却処理の漏れを防いだ。' : '台帳と現物はぴったり一致。日頃の管理の賜物だ。'],
          effects: found ? { skill: 3, trust: 3, stress: 3 } : { skill: 2, stress: 2 },
        };
      }),
      sq(9, '連休前の前倒し', '⏩', 'move', () => ({
        title: 'シルバーウィーク前の前倒し', icon: '⏩',
        text: ['連休前に支払処理も月次の準備も片付けた！', '⏩ 2マス進む'],
        effects: { stress: -5, trust: 2 },
        move: 2,
      }), { note: '2マス進む' }),
      sq(9, '中間決算', '📊', 'work', workEvent({
        title: '中間決算（9月末）', icon: '📊',
        text: ['上期末の9月30日。中間決算の締め作業が始まる。'],
        target: 6,
        success: { text: '上期の数字をしっかり固めた！', effects: { skill: 5, trust: 4, stress: 8 } },
        failure: { text: '減損の兆候の検討が漏れていて、監査法人から指摘が…。', effects: { skill: 2, trust: -3, stress: 12 } },
      }), { note: '9/30' }),
    ],
  },
  // ---- 分かれ道②（10月）
  {
    id: 'project', x: 6, y: 4, dir: -1, next: ['d'],
    squares: [
      sq(10, '新会計システム導入', '💻', 'work', workEvent({
        title: '新会計システム導入プロジェクト', icon: '💻',
        text: ['基幹の会計システムを刷新するプロジェクトに抜擢された！勘定科目体系から見直す。'],
        target: 6,
        success: { text: '要件定義を見事にまとめ、ベンダーからも一目置かれた。', effects: { skill: 8, trust: 6, stress: 10 } },
        failure: { text: '現場の要望をまとめきれず、スケジュールが遅延…。', effects: { skill: 4, trust: -3, stress: 14 } },
      })),
      sq(10, 'M&Aのデューデリ', '🤝', 'work', workEvent({
        title: 'M&Aの財務デューデリジェンス', icon: '🤝',
        text: ['買収候補の会社の財務調査を任された。簿外債務はないか…？'],
        target: 7,
        success: { text: '未払残業代のリスクを発見し、買収価格の交渉に貢献！', effects: { skill: 8, trust: 8, stress: 12 } },
        failure: { text: '重要な論点を見落とし、アドバイザーに指摘されてしまった…。', effects: { skill: 3, trust: -4, stress: 15 } },
        overtimeStress: 12,
      })),
      sq(10, '本番稼働', '🚦', 'move', (ctx) => {
        const roll = check(ctx, 4);
        return roll.success
          ? {
            title: '新システム本番稼働', icon: '🚦', roll,
            text: ['✅ データ移行も無事に完了し、新システムが稼働した！', 'プロジェクトの打ち上げで乾杯！'],
            effects: { trust: 6, stress: -10 },
          }
          : {
            title: '新システム本番稼働', icon: '🚦', roll,
            text: ['❌ 移行データの残高が合わない！移行リハーサルからやり直しに…。', '⏪ 3マス戻る'],
            effects: { stress: 10 },
            move: -3,
          };
      }, { note: '失敗で3マス戻る' }),
    ],
  },
  {
    id: 'routine', x: 7, y: 5, dir: -1, next: ['d'],
    squares: [
      sq(10, '決算整理仕訳', '📝', 'quiz', quizEvent('決算整理仕訳クイズ')),
      sq(10, '期中レビュー', '🔍', 'work', workEvent({
        title: '監査法人の期中レビュー', icon: '🔍',
        text: ['中間決算について、監査法人のレビューを受ける。'],
        target: 5,
        success: { text: '大きな指摘はなく、無事に完了。', effects: { skill: 4, trust: 4, stress: 5 } },
        failure: { text: '注記の記載漏れを指摘された…。', effects: { trust: -2, stress: 10 } },
      })),
      sq(10, 'ライフイベント', '💞', 'life', lifeEvent),
      sq(10, '有給休暇', '🌴', 'rest', simpleEvent('有給休暇', '🌴', ['中間決算が落ち着いたので有給休暇を取得。平日の空いている観光地へ。'], { stress: -15 })),
    ],
  },
  {
    id: 'd', x: 3, y: 5, dir: -1, next: ['e'],
    squares: [
      sq(10, '税務調査', '🕵️', 'trouble', workEvent({
        title: '税務調査の連絡', icon: '🕵️',
        text: ['税務署から「法人税の調査に伺いたい」と電話が…！過去3期分の帳簿書類を準備する。'],
        target: 7,
        success: { text: '指摘事項なし（申告是認）！日頃の丁寧な処理が報われた。', effects: { skill: 5, trust: 8, stress: 8 } },
        failure: { text: ['交際費と会議費の区分について指摘され、修正申告に…。', '⏪ 過去の帳簿を洗い直すため2マス戻る'], effects: { skill: 3, trust: -5, stress: 15 }, move: -2 },
        overtimeStress: 12,
      }), { note: '失敗で2マス戻る' }),
      sq(11, '半期報告書', '📘', 'work', workEvent({
        title: '半期報告書の提出', icon: '📘',
        text: ['中間期末から45日以内に半期報告書を提出する。'],
        target: 6,
        success: { text: 'EDINETでの提出完了！', effects: { skill: 4, trust: 5, stress: 6 } },
        failure: { text: '提出直前に表示の誤りが見つかり、深夜まで修正…。', effects: { trust: -3, stress: 12 } },
      }), { note: '〜11/14' }),
      sq(11, '簿記検定（11月）', '🎓', 'exam', examEvent(11)),
      sq(11, '中間申告・納付', '🏛️', 'work', () => ({
        title: '法人税等の中間申告', icon: '🏛️',
        text: ['3月決算法人の中間申告期限は11月30日。どちらの方法で申告する？'],
        choices: [
          { label: '予定申告（前年実績の1/2）', note: 'スキル＋2／ストレス＋2', run: () => ({ text: ['前年の法人税額の半分で手堅く申告・納付した。'], effects: { skill: 2, stress: 2 } }) },
          { label: '仮決算による中間申告', note: 'スキル＋5／信頼＋3／ストレス＋8', run: () => ({ text: ['上期が減益だったので仮決算で納税額を抑え、資金繰りに貢献した！'], effects: { skill: 5, trust: 3, stress: 8 } }) },
        ],
      }), { note: '11/30' }),
    ],
  },
  {
    id: 'e', x: 0, y: 6, dir: 1, next: ['planning', 'study'],
    squares: [
      sq(11, '年末調整の準備', '📨', 'work', () => ({
        title: '年末調整の準備', icon: '📨',
        text: ['扶養控除等申告書や保険料控除申告書を全社員から回収する。提出が遅い人が必ずいる…。'],
        choices: [
          { label: '一人ずつ声をかける', note: '信頼＋4／ストレス＋6', run: () => ({ text: ['丁寧なフォローで全員分がそろった。'], effects: { trust: 4, stress: 6 } }) },
          {
            label: '全社メールで督促する', note: '運しだい',
            run: (ctx) => (ctx.dice() >= 3
              ? { text: ['メール一本で期限内にそろった！'], effects: { stress: 2 } }
              : { text: ['締切を過ぎても数十人分が未提出…。'], effects: { trust: -2, stress: 8 } }),
          },
        ],
      })),
      sq(12, '冬の賞与', '💰', 'money', bonusEvent('冬')),
      sq(12, '年末調整', '🧮', 'work', workEvent({
        title: '年末調整', icon: '🧮',
        text: ['12月の給与で年末調整。1年間の所得税を精算する。'],
        target: 5,
        success: { text: '全員分の過不足精算が完了。「還付されてうれしい」の声も。', effects: { skill: 5, trust: 5, stress: 8 } },
        failure: { text: '扶養の入力ミスが発覚し、1月に再年調をすることに…。', effects: { skill: 2, trust: -4, stress: 12 } },
      })),
      sq(12, '忘年会', '🍻', 'rest', () => ({
        title: '忘年会', icon: '🍻',
        text: ['今年も一年おつかれさまでした！'],
        choices: [
          { label: '幹事を引き受ける', note: '会費5,000円／信頼＋6／ストレス＋5', run: () => ({ text: ['会計はもちろん1円単位でぴったり。さすが経理！'], effects: { money: -5000, trust: 6, stress: 5 } }) },
          { label: '参加して楽しむ', note: '会費5,000円／信頼＋3／ストレス−5', run: () => ({ text: ['他部署の人とも交流できた。'], effects: { money: -5000, trust: 3, stress: -5 } }) },
          { label: '欠席して帰る', note: 'ストレス−8', run: () => ({ text: ['家でゆっくり年末気分。'], effects: { stress: -8 } }) },
        ],
      })),
      sq(12, '仕事納め', '🎍', 'rest', simpleEvent('仕事納め', '🎍', ['年内の支払処理をすべて完了。今年もよくがんばった！', 'でも1月は法定調書と償却資産申告が待っている…。'], { stress: -10 })),
      sq(1, '法定調書・給与支払報告書', '📑', 'work', workEvent({
        title: '法定調書・給与支払報告書', icon: '📑',
        text: ['1月31日は法定調書合計表と給与支払報告書の提出期限。支払調書を集計する。'],
        target: 5,
        success: { text: 'eLTAXとe-Taxで期限内に提出完了！', effects: { skill: 4, trust: 3, stress: 6 } },
        failure: { text: '報酬の支払調書の集計漏れが見つかり、追加提出に…。', effects: { trust: -2, stress: 10 } },
      }), { note: '1/31' }),
      sq(1, '償却資産申告', '🏭', 'work', simpleEvent('償却資産申告', '🏭', ['1月1日現在の償却資産を、各市町村に申告する（1月31日期限）。', '拠点ごとに申告書を作成…。'], { skill: 3, stress: 5 }), { note: '1/31' }),
      sq(2, 'Q3決算短信', '📢', 'work', workEvent({
        title: '第3四半期決算短信', icon: '📢',
        text: ['12月末で締めた第3四半期の決算短信を、2月中旬までに開示する。'],
        target: 6,
        success: { text: '期限内に開示完了！通期の着地見込みも見えてきた。', effects: { skill: 4, trust: 4, stress: 6 } },
        failure: { text: '業績予想の修正が必要かで大混乱…。', effects: { trust: -3, stress: 12 } },
      }), { note: '〜2/14頃' }),
    ],
  },
  // ---- 分かれ道③（2月）
  {
    id: 'planning', x: 6, y: 7, dir: -1, next: ['f'],
    squares: [
      sq(2, '次年度予算策定', '📈', 'work', () => ({
        title: '次年度予算策定', icon: '📈',
        text: ['来期の予算編成の季節。各部門から予算案が集まってくる。'],
        choices: [
          { label: '各部門と徹底的に調整', note: '信頼＋6／スキル＋2／ストレス＋8', run: () => ({ text: ['納得感のある予算ができあがった。'], effects: { trust: 6, skill: 2, stress: 8 } }) },
          { label: '前年踏襲で済ませる', note: '信頼−2／ストレス−2', run: () => ({ text: ['「今年も去年と同じ？」と役員に言われてしまった。'], effects: { trust: -2, stress: -2 } }) },
        ],
      })),
      sq(2, '取締役会で報告', '🏢', 'work', workEvent({
        title: '取締役会で業績報告', icon: '🏢',
        text: ['部長の代理で、取締役会で月次業績を報告することに…！'],
        target: 6,
        success: { text: '社外取締役の鋭い質問にも的確に回答できた！', effects: { skill: 3, trust: 9, stress: 8 } },
        failure: { text: '差異分析の説明がしどろもどろに…。', effects: { trust: -4, stress: 12 } },
      })),
      sq(2, '中期経営計画', '🧭', 'work', () => ({
        title: '中期経営計画の策定', icon: '🧭',
        text: ['3か年の中期経営計画づくりに参加する。数値計画はどう作る？'],
        choices: [
          {
            label: '攻めの投資計画を提案する', note: '運しだい（成功で信頼＋10）',
            run: (ctx) => (ctx.dice() >= 4
              ? { text: ['ROE目標と投資計画が経営陣に採用された！'], effects: { trust: 10, skill: 3, stress: 6 } }
              : { text: ['「その前提は楽観的すぎる」と差し戻された…。'], effects: { trust: -3, stress: 8 } }),
          },
          { label: '手堅く積み上げる', note: 'スキル＋3／信頼＋3', run: () => ({ text: ['実現可能性の高い計画として評価された。'], effects: { skill: 3, trust: 3, stress: 4 } }) },
        ],
      })),
    ],
  },
  {
    id: 'study', x: 7, y: 8, dir: -1, next: ['f'],
    squares: [
      sq(2, '仕訳クイズ', '✏️', 'quiz', quizEvent()),
      sq(2, '簿記検定（2月）', '🎓', 'exam', examEvent(2)),
      sq(2, '会計セミナー', '🎓', 'rest', simpleEvent('会計基準セミナー', '🎓', ['監査法人主催のセミナーで、新しいリース会計基準の実務対応を学んだ。'], { skill: 6, stress: 2 })),
      sq(2, 'ライフイベント', '💞', 'life', lifeEvent),
    ],
  },
  {
    id: 'f', x: 3, y: 8, dir: -1, next: ['a'],
    squares: [
      sq(3, '実地棚卸', '📦', 'work', workEvent({
        title: '期末の実地棚卸', icon: '📦',
        text: ['倉庫で在庫をひたすらカウント！帳簿在庫との差異はあるか…？'],
        target: 4,
        success: { text: '棚卸差異はごくわずか。原因もすぐに特定できた。', effects: { skill: 3, trust: 3, stress: 5 } },
        failure: { text: '大きな棚卸差異が発生…原因調査で終電コース。', effects: { trust: -2, stress: 12 } },
      })),
      sq(3, '決算準備', '✉️', 'work', () => ({
        title: '決算準備', icon: '✉️',
        text: ['取引先への残高確認状の発送、決算スケジュールの作成…。準備が決算の成否を分ける。'],
        choices: [
          { label: '早めに準備を進める', note: 'スキル＋3／信頼＋3／ストレス＋6', run: () => ({ text: ['段取り八分。これで決算も安心だ。'], effects: { skill: 3, trust: 3, stress: 6 } }) },
          { label: 'ギリギリまで様子見', note: '信頼−2／ストレス−3', run: () => ({ text: ['上司が少し心配そうにこちらを見ている…。'], effects: { trust: -2, stress: -3 } }) },
        ],
      })),
      sq(3, '年度末の駆け込み精算', '🧾', 'move', (ctx) => {
        const roll = check(ctx, 4);
        return roll.success
          ? {
            title: '年度末の駆け込み精算', icon: '🧾', roll,
            text: ['「今期の費用で落としたい」請求書が大量に届いた。', '✅ 発生主義で計上時期をチェックし、期ズレを防いだ！'],
            effects: { skill: 3, stress: 6 },
          }
          : {
            title: '年度末の駆け込み精算', icon: '🧾', roll,
            text: ['「今期の費用で落としたい」請求書が大量に届いた。', '❌ 未払計上の漏れが見つかり、決算準備をやり直し…。', '⏪ 2マス戻る'],
            effects: { stress: 10 },
            move: -2,
          };
      }, { note: '失敗で2マス戻る' }),
      sq(3, '決算日', '🏁', 'stop', closingEvent, { stop: true, note: '3/31' }),
    ],
  },
];

function buildSquares(segments) {
  const byId = new Map(segments.map((seg) => [seg.id, seg]));
  segments.forEach((seg) => seg.squares.forEach((square, i) => {
    square.id = `${seg.id}${i + 1}`;
    square.at = [seg.x + seg.dir * i, seg.y];
    if (LANES[seg.id]) square.lane = seg.id;
  }));
  const squares = [];
  for (const seg of segments) {
    seg.squares.forEach((square, i) => {
      if (i < seg.squares.length - 1) {
        square.next = [seg.squares[i + 1].id];
        return;
      }
      const targets = seg.next.map((id) => byId.get(id));
      square.next = targets.map((t) => t.squares[0].id);
      if (targets.length > 1) {
        square.branches = targets.map((t) => ({
          lane: t.id,
          to: t.squares[0].id,
          length: t.squares.length,
          preview: t.squares.map((s) => `${s.icon}${s.name}`),
          ...LANES[t.id],
        }));
      }
    });
    squares.push(...seg.squares);
  }
  return squares;
}

/** 盤面の全マス。先頭が期首（スタート）、最後が決算日（ゴール） */
export const SQUARES = buildSquares(SEGMENTS);
export const BOARD_COLS = 8;
export const BOARD_ROWS = 9;

/** 盤面の空きスペースに置く、分かれ道の案内板 */
export const SIGNS = [
  { at: [0, 1], width: 3, title: '🔀 6〜7月の分かれ道', lanes: ['disclosure', 'tax'] },
  { at: [0, 4], width: 3, title: '🔀 10月の分かれ道', lanes: ['project', 'routine'] },
  { at: [0, 7], width: 3, title: '🔀 2月の分かれ道', lanes: ['planning', 'study'] },
];

const LANE_OF = new Map(SQUARES.map((s) => [s.id, s.lane]));

/** 通ってきたマスの列から、選んだルートを順に取り出す */
export function lanesOnTrail(trail = []) {
  const lanes = [];
  for (const id of trail) {
    const lane = LANE_OF.get(id);
    if (lane && !lanes.includes(lane)) lanes.push(lane);
  }
  return lanes;
}
