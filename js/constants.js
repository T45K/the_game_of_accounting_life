// ゲーム全体で使う定数

/** 3月決算：期首4月〜期末3月 */
export const MONTH_ORDER = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];

/** 役職（threshold は「スキル＋信頼」の評価ポイント） */
export const RANKS = [
  { id: 'staff', name: '担当', salary: 220000, threshold: 0, points: 0 },
  { id: 'chief', name: '主任', salary: 260000, threshold: 70, points: 50 },
  { id: 'leader', name: '係長', salary: 300000, threshold: 130, points: 100 },
  { id: 'manager', name: '経理課長', salary: 380000, threshold: 200, points: 200, requires: 'boki2' },
  { id: 'director', name: '経理部長', salary: 480000, threshold: 280, points: 350, requires: 'boki2' },
  { id: 'cfo', name: 'CFO', salary: 650000, threshold: 370, points: 600, requires: 'boki1' },
];

/** 管理職（残業代が出ない）になる役職インデックス */
export const MANAGER_RANK_INDEX = 3;

/** 資格（受験料は日商簿記の統一試験の受験料） */
export const CERTS = {
  boki3: { id: 'boki3', name: '日商簿記3級', short: '簿記3級', fee: 3300, target: 4, allowance: 0, points: 20 },
  boki2: { id: 'boki2', name: '日商簿記2級', short: '簿記2級', fee: 5500, target: 7, allowance: 10000, points: 60 },
  boki1: { id: 'boki1', name: '日商簿記1級', short: '簿記1級', fee: 8800, target: 10, allowance: 30000, points: 150 },
};
export const CERT_ORDER = ['boki3', 'boki2', 'boki1'];

/** 入社ルート */
export const ROUTES = {
  newgrad: {
    name: '新卒入社',
    desc: '経理部に新卒で配属。バランス型で伸びしろ抜群！',
    skill: 10, trust: 10, stress: 10, money: 300000, certs: [],
  },
  career: {
    name: '経験者転職',
    desc: '簿記2級を持つ即戦力。ただし社内の人脈はゼロから。',
    skill: 25, trust: 0, stress: 25, money: 300000, certs: ['boki3', 'boki2'],
  },
  transfer: {
    name: '営業部から異動',
    desc: '簿記は未経験。でも社内の顔の広さはピカイチ。',
    skill: 0, trust: 30, stress: 10, money: 500000, certs: [],
  },
};

/** ゲームの長さ（期数） */
export const LENGTHS = [
  { years: 1, label: '1期（お試し・約5分）' },
  { years: 3, label: '3期（標準・約15分）' },
  { years: 5, label: '5期（じっくり・約25分）' },
];

export const BASE_LIVING_COST = 150000;
export const CHILD_LIVING_COST = 20000;
export const HOUSE_LIVING_COST = 30000;
export const OVERTIME_PAY = 20000;
export const HOUSE_DOWN_PAYMENT = 3000000;
