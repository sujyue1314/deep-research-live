// 经典大富翁引擎：28 格棋盘、地产组、租金、骰子、看守所、破产清算
// 一切现金以"万元"为单位，沿用江城人物设定。

export const BOARD = [
  { idx: 0, name: "起点", type: "go", desc: "经过即收 200 万" },
  { idx: 1, name: "望江东路", type: "property", group: "yellow", price: 100, rentBase: 20 },
  { idx: 2, name: "命运", type: "fate", desc: "抽一张命运卡" },
  { idx: 3, name: "望江西路", type: "property", group: "yellow", price: 100, rentBase: 20 },
  { idx: 4, name: "所得税", type: "tax", amount: 150, desc: "缴纳 150 万" },
  { idx: 5, name: "老城站", type: "station", group: "station", price: 200, rentBase: 0 },
  { idx: 6, name: "银杏大道", type: "property", group: "lightblue", price: 120, rentBase: 30 },
  { idx: 7, name: "机会", type: "chance", desc: "抽一张机会卡" },
  { idx: 8, name: "银杏巷", type: "property", group: "lightblue", price: 120, rentBase: 30 },
  { idx: 9, name: "银杏里", type: "property", group: "lightblue", price: 140, rentBase: 35 },
  { idx: 10, name: "看守所", type: "jail", desc: "只是来探监，相安无事" },
  { idx: 11, name: "梧桐南路", type: "property", group: "pink", price: 160, rentBase: 40 },
  { idx: 12, name: "梧桐北路", type: "property", group: "pink", price: 160, rentBase: 40 },
  { idx: 13, name: "电力公司", type: "utility", group: "utility", price: 150, rentBase: 0 },
  { idx: 14, name: "梧桐西路", type: "property", group: "pink", price: 180, rentBase: 45 },
  { idx: 15, name: "滨江码头站", type: "station", group: "station", price: 200, rentBase: 0 },
  { idx: 16, name: "外滩大街", type: "property", group: "orange", price: 200, rentBase: 60 },
  { idx: 17, name: "命运", type: "fate", desc: "抽一张命运卡" },
  { idx: 18, name: "外滩二村", type: "property", group: "orange", price: 220, rentBase: 65 },
  { idx: 19, name: "外滩三里", type: "property", group: "orange", price: 240, rentBase: 70 },
  { idx: 20, name: "免费停车", type: "parking", desc: "歇一会，太平无事" },
  { idx: 21, name: "入狱！", type: "gojail", desc: "直接送去看守所" },
  { idx: 22, name: "琉璃厂南街", type: "property", group: "red", price: 260, rentBase: 80 },
  { idx: 23, name: "机会", type: "chance", desc: "抽一张机会卡" },
  { idx: 24, name: "琉璃厂北街", type: "property", group: "red", price: 280, rentBase: 85 },
  { idx: 25, name: "高新园站", type: "station", group: "station", price: 200, rentBase: 0 },
  { idx: 26, name: "云顶东路", type: "property", group: "green", price: 300, rentBase: 100 },
  { idx: 27, name: "云顶西路", type: "property", group: "green", price: 320, rentBase: 105 },
];

export const GROUPS = {
  yellow: { name: "望江组", color: "#e8b339", members: [1, 3] },
  lightblue: { name: "银杏组", color: "#7ec8e3", members: [6, 8, 9] },
  pink: { name: "梧桐组", color: "#e36bae", members: [11, 12, 14] },
  orange: { name: "外滩组", color: "#e07b39", members: [16, 18, 19] },
  red: { name: "琉璃厂组", color: "#d94141", members: [22, 24] },
  green: { name: "云顶组", color: "#4caf7d", members: [26, 27] },
  station: { name: "车站", color: "#9aa3ad", members: [5, 15, 25] },
  utility: { name: "公用事业", color: "#26a69a", members: [13] },
};

// 建筑等级：0 空地 / 1 一栋房 / 2 酒店
export const BUILDINGS = ["空地", "一栋房", "酒店"];
export const GO_REWARD = 200;
export const JAIL_FEE = 50;
export const TAX = 150;
export const MAX_ROUNDS = 50;

export const PERSONAS = [
  {
    id: "zheng", name: "郑伯昌", title: "老钱·收租公", color: "#c9a227", kind: "ai",
    bio: "城中村起家，年轻时拆出第一桶金，如今握着一整条老街。信奉“租金才是真的”，口头禅是“我这铺子十年前就这个价”。面相敦厚，心里一本账。",
    strategy: "买核心区与学区收租，囤现金；别人缺钱时“帮把手”——五折收货。讨厌折腾，但记仇。",
  },
  {
    id: "kai", name: "洪凯文", title: "杠杆炒客", color: "#e05252", kind: "ai",
    bio: "私募出身，朋友圈签名“杠杆是人类的第八大奇迹”。上轮牛市翻过五倍也爆过两次仓，至今觉得第三次会不同。话多，手更痒。",
    strategy: "什么都敢买，尤其爱高价抢核心地块恶心人；喜欢主动找人换地凑整组。",
  },
  {
    id: "lin", name: "林曼卿", title: "价值派·做局者", color: "#7b6cf6", kind: "ai",
    bio: "某投资基金合伙人，永远在算别人的底牌。说话客气到让你心慌，下手从不客气。",
    strategy: "只捡便宜的地，便宜够了就收；最擅长联合老二搞老大——谁领先她就拉拢谁针对谁。",
  },
];

export const PLAYER = {
  id: "you", name: "你", title: "新晋土豪", color: "#3aa7ff", kind: "human",
};

export function uid(prefix = "g") {
  return prefix + "_" + Math.random().toString(36).slice(2, 9);
}

function rng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul((t ^ (t >>> 7)) ^ (61 | t), t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export { rng };

export function newGame(spec = {}) {
  const spaces = BOARD.map((s) => ({
    ...s,
    owner: "bank",
    building: 0, // 0 空地 / 1 一栋房 / 2 酒店
  }));

  const players = [PLAYER, ...PERSONAS].map((p) => ({
    ...p,
    cash: 1500,
    position: 0,
    jailed: false,
    jailTurns: 0,
    isBankrupt: false,
    memory: [],
    relations: {},
    stats: { bought: 0, built: 0, rentCollected: 0, rentPaid: 0 },
  }));

  return {
    id: uid("mono"),
    round: 1,
    phase: "idle", // idle | turn | resolving | ai | over
    mode: spec.mode || "normal", // normal | spectator
    spaces,
    players,
    currentIdx: 0, // 当前行动玩家在 players 数组中的位置
    turn: {
      canRoll: true, // 还能掷骰（含连掷 doubles）
      doublesChain: 0,
      awaitingBuy: null, // {spaceIdx, price}
      rolled: null, // [d1, d2]
    },
    offers: [],
    negotiationLog: {},
    pendingCard: null,
    cardHistory: [],
    log: [],
    over: false,
    ranking: null,
    epilogues: {},
    createdAt: Date.now(),
    seed: spec.seed ?? Math.floor(Math.random() * 1e9),
  };
}

// ---------- 基础查询 ----------

export function currentPlayer(state) {
  return state.players[state.currentIdx];
}

export function spaceAt(state, idx) {
  return state.spaces[(idx + BOARD.length) % BOARD.length];
}

export function groupMembers(state, group) {
  return state.spaces.filter((s) => s.group === group);
}

export function ownsGroup(state, playerId, group) {
  return groupMembers(state, group).every((s) => s.owner === playerId);
}

export function buildingCost(space) {
  if (space.building === 0) return Math.round(space.price * 0.5); // 买房
  if (space.building === 1) return Math.round(space.price * 0.5); // 房→酒店
  return 0;
}

// 某地块当前应付租金（过路费）
export function rentFor(state, space, dice) {
  if (space.type === "station") {
    const n = state.spaces.filter((s) => s.type === "station" && s.owner === space.owner).length;
    return 50 * n;
  }
  if (space.type === "utility") {
    return dice[0] + dice[1];
  }
  // 普通地产
  const setComplete = ownsGroup(state, space.owner, space.group);
  const base = space.rentBase;
  if (space.building === 1) return base * 5;
  if (space.building === 2) return base * 20;
  return setComplete ? base * 2 : base;
}

// 地产账面价值（用于排名/清算）
export function propertyValue(space) {
  const b = space.building;
  const bonus = b === 1 ? space.price * 0.5 : b === 2 ? space.price : 0;
  return Math.round(space.price + bonus);
}

export function netAssets(state, player) {
  let a = player.cash;
  state.spaces
    .filter((s) => s.owner === player.id)
    .forEach((s) => {
      a += propertyValue(s);
    });
  return Math.round(a);
}

export function standings(state) {
  return state.players
    .map((p) => ({
      id: p.id, name: p.name, title: p.title, color: p.color, kind: p.kind,
      cash: Math.round(p.cash), assets: netAssets(state, p),
      isBankrupt: p.isBankrupt,
      props: state.spaces.filter((s) => s.owner === p.id).length,
      position: p.position,
      jailed: p.jailed,
    }))
    .sort((a, b) => {
      if (a.isBankrupt !== b.isBankrupt) return a.isBankrupt ? 1 : -1;
      return b.assets - a.assets;
    });
}

// ---------- 骰子与移动 ----------

export function rollDice(rand) {
  const d1 = 1 + Math.floor(rand() * 6);
  const d2 = 1 + Math.floor(rand() * 6);
  return [d1, d2];
}

export const DICE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

// ---------- 现金与破产 ----------

export function pay(state, player, amount) {
  player.cash -= amount;
}

// 破产清算：按建筑→地块（便宜的先）半价抛售，直到现金回正；仍为负则破产
export function liquidate(state, player) {
  const sold = [];
  const mine = state.spaces.filter((s) => s.owner === player.id);
  // 先变卖建筑（半价）
  for (const s of mine.slice().sort((a, b) => a.price - b.price)) {
    if (player.cash >= 0) break;
    if (s.building > 0) {
      const refund = Math.round(s.price * 0.25 * s.building);
      player.cash += refund;
      sold.push({ spaceIdx: s.idx, what: BUILDINGS[s.building], refund });
      s.building = 0;
    }
  }
  // 再卖地（半价还给银行）
  for (const s of mine.slice().sort((a, b) => a.price - b.price)) {
    if (player.cash >= 0) break;
    const refund = Math.round(s.price * 0.5);
    player.cash += refund;
    sold.push({ spaceIdx: s.idx, what: s.name, refund });
    s.owner = "bank";
    s.building = 0;
  }
  const bankrupt = player.cash < 0;
  if (bankrupt) {
    player.isBankrupt = true;
    // 剩余资产全部清零交给银行
    state.spaces
      .filter((s) => s.owner === player.id)
      .forEach((s) => {
        s.owner = "bank";
        s.building = 0;
      });
    player.cash = 0;
  }
  return { sold, bankrupt };
}
