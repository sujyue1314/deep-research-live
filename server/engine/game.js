// 经典大富翁会话：回合状态机 + 落地结算 + 建房 + 交易 + AI 自动回合 + 存档
import fs from "node:fs";
import path from "node:path";
import {
  newGame, rng, spaceAt, ownsGroup, buildingCost,
  rentFor, netAssets, standings, liquidate, rollDice, uid,
  GO_REWARD, JAIL_FEE, TAX, MAX_ROUNDS, BUILDINGS, BOARD, GROUPS,
} from "./world.js";
import {
  cardAgent, npcAgent, negotiationAgent, commentatorAgent,
  epilogueAgent,
} from "../ai/agents.js";

const SAVES_DIR = path.join(process.cwd(), "server", "saves");
try { fs.mkdirSync(SAVES_DIR, { recursive: true }); } catch {}

// 观战模式人类槽位人格
const PLAYER_AI_EXTRA = {
  bio: "白手起家的散户，上轮江城拆迁吃满了第一桶金。信奉“别人贪婪我更贪婪”，掷骰子大手一挥就敢全仓买地。",
  strategy: "跟风强庄，看到好地段就买；现金少的时候敢梭哈，有钱了反而犹豫。",
};

export class GameSession {
  constructor(spec = {}) {
    this.state = spec.state ?? newGame(spec);
    if (this.state.mode === "spectator" && this.state.players[0]?.kind === "human") {
      Object.assign(this.state.players[0], PLAYER_AI_EXTRA, { kind: "ai" });
    }
    this.rand = rng(this.state.seed ?? 587);
    this.listeners = new Set();
    this.busy = false;
    this.ending = false;
    this.subscribers = 0;
  }

  // ---- 事件总线 ----
  on(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  emit(evt) {
    evt.gameId = this.state.id;
    for (const cb of this.listeners) {
      try { cb(evt); } catch {}
    }
  }
  log(text, tone = "info") {
    this.state.log.push({ r: this.state.round, text, tone, t: Date.now() });
    if (this.state.log.length > 400) this.state.log.shift();
    this.emit({ type: "log", text, tone, round: this.state.round });
    this.save();
  }
  pushState() { this.emit({ type: "state", state: this.state }); this.save(); }

  save() {
    try {
      fs.writeFileSync(path.join(SAVES_DIR, `${this.state.id}.json`), JSON.stringify(this.state));
    } catch {}
  }
  static load(id) {
    try {
      const raw = fs.readFileSync(path.join(SAVES_DIR, `${id}.json`), "utf8");
      return new GameSession({ state: JSON.parse(raw) });
    } catch { return null; }
  }

  addSubscriber() { this.subscribers++; }
  dropSubscriber() { this.subscribers = Math.max(0, this.subscribers - 1); }
  get watched() { return this.subscribers > 0; }
  async guardWatchers() {
    while (!this.watched && !this.state.over) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // ---- 流式文本广播（带空内容重试） ----
  async streamText(channel, meta, fn, tries = 2) {
    for (let i = 0; i < tries; i++) {
      let acc = "";
      const r = await fn((chunk) => { acc += chunk; this.emit({ type: "text-chunk", channel, chunk, ...meta }); })
        .catch((e) => null);
      if (acc.trim()) return r;
      this.emit({ type: "text-reset", channel, retry: i + 1, ...meta });
      await new Promise((r2) => setTimeout(r2, 1000));
    }
    return null;
  }

  // ---------- 开始 ----------
  async start() {
    if (this.state.phase === "idle") {
      this.beginTurn();
    } else {
      this.pushState();
      // 补齐被中断的 AI 回合
      const p = this.state.players[this.state.currentIdx];
      if (!this.state.over && this.isAi(p) && this.state.phase === "turn") {
        if (p.jailed) await this.aiJailTurn(p);
        else if (this.state.turn?.canRoll) await this.rollAndResolve(p);
        else if (!this.state.turn?.aiResolved)
          await this.runAiDecision(p, this.state.turn?.rolled || [1, 1]);
        else await this.advance();
      }
    }
  }

  isAi(p) {
    return p.kind === "ai" || this.state.mode === "spectator";
  }

  // ---------- 回合开始 ----------
  async beginTurn() {
    if (this.state.over) return;
    this.busy = false;
    const p = this.state.players[this.state.currentIdx];
    if (!p || p.isBankrupt) { this.advance(); return; }
    this.state.phase = "turn";
    this.state.turn = { canRoll: true, doublesChain: 0, awaitingBuy: null, rolled: null, aiResolved: false };
    this.state.negotiatedThisTurn = {};
    this.state.pendingCard = null;
    this.emit({ type: "phase", phase: "turn", round: this.state.round });
    this.log(`━━ 第 ${this.state.round} 回合 · ${p.name} 的回合 ━━`, "round");
    this.pushState();

    if (this.isAi(p)) {
      if (this.state.mode === "spectator") await this.guardWatchers();
      if (p.jailed) await this.aiJailTurn(p);
      else await this.rollAndResolve(p);
    }
  }

  // ---------- 玩家行动接口 ----------
  async playerAction(action) {
    if (this.state.over) return { ok: false, msg: "本局已结束" };
    const p = this.state.players[this.state.currentIdx];
    if (!p) return { ok: false, msg: "无玩家" };
    if (this.isAi(p)) return { ok: false, msg: "当前不是你的回合" };
    if (this.busy) return { ok: false, msg: "等待动作完成" };
    if (this.state.phase !== "turn") return { ok: false, msg: "当前不能操作" };

    switch (action?.type) {
      case "roll":
        if (p.jailed) return { ok: false, msg: "你在看守所，请选择保释或赌一把" };
        if (!this.state.turn.canRoll) return { ok: false, msg: "本回合已掷过骰子" };
        return await this.rollAndResolve(p);
      case "jailPay":
        if (!p.jailed) return { ok: false, msg: "你不在看守所" };
        {
          const r = this.doJailPay(p);
          if (r.ok) return await this.rollAndResolve(p);
          return r;
        }
      case "jailRoll":
        if (!p.jailed) return { ok: false, msg: "你不在看守所" };
        return await this.jailRollOnce(p);
      case "buy":
        return this.doBuy(p);
      case "skip":
        return this.doSkip(p);
      case "build":
        return this.doBuild(p, action.spaceIdx);
      case "endTurn":
        if (this.state.turn.awaitingBuy) return { ok: false, msg: "先决定买不买脚下的地块" };
        if (this.state.turn.canRoll) return { ok: false, msg: "先掷骰子" };
        this.busy = true;
        await this.advance();
        return { ok: true };
      default:
        return { ok: false, msg: "未知行动" };
    }
  }

  // ---------- 掷骰与落点 ----------
  async rollAndResolve(p) {
    if (!this.state.turn.canRoll) return { ok: false, msg: "本回合不能再掷骰" };
    this.busy = true;
    this.state.turn.canRoll = false;
    this.state.turn.aiResolved = false; // 每次掷骰都允许一次 AI 决策（含双数连掷）
    const dice = rollDice(this.rand);
    this.state.turn.rolled = dice;
    const isDouble = dice[0] === dice[1];
    if (isDouble) this.state.turn.doublesChain++;
    else this.state.turn.doublesChain = 0;

    this.emit({ type: "dice", dice, doubles: isDouble, playerId: p.id });
    this.log(`${p.name} 掷出 ${dice[0]} + ${dice[1]} = ${dice[0] + dice[1]}${isDouble ? "（双数）" : ""}`, "roll");

    // 连掷三次双数 → 入狱
    if (this.state.turn.doublesChain >= 3) {
      this.log(`${p.name} 连掷三次双数，被押进看守所！`, "bad");
      this.sendToJail(p);
      this.pushState();
      await this.endOfRoll(p);
      return { ok: true };
    }

    // 移动（含过起点）
    const oldPos = p.position;
    const total = oldPos + dice[0] + dice[1];
    p.position = total % BOARD.length;
    if (total >= BOARD.length) {
      p.cash += GO_REWARD;
      this.log(`${p.name} 经过起点，收取 ${GO_REWARD} 万`, "money");
    }
    this.emit({ type: "move", playerId: p.id, position: p.position, dice });
    const space = spaceAt(this.state, p.position);
    this.log(`${p.name} 落在「${space.name}」`, "move");
    this.pushState();

    await this.resolveLanding(p, space, dice);
    return { ok: true };
  }

  // ---------- 看守所 ----------
  doJailPay(p) {
    if (p.cash < JAIL_FEE) return { ok: false, msg: "现金不足" };
    p.cash -= JAIL_FEE;
    p.jailed = false;
    p.jailTurns = 0;
    this.log(`${p.name} 花 ${JAIL_FEE} 万保释出狱`, "money");
    this.pushState();
    return { ok: true };
  }

  async jailRollOnce(p) {
    this.busy = true;
    const dice = rollDice(this.rand);
    const isDouble = dice[0] === dice[1];
    this.emit({ type: "dice", dice, doubles: isDouble, playerId: p.id });
    this.state.turn.rolled = dice;
    if (isDouble) {
      this.log(`${p.name} 掷出双数 ${dice[0]}，出狱！`, "good");
      p.jailed = false;
      p.jailTurns = 0;
      this.pushState();
      // 出狱后按点数移动
      const total = p.position + dice[0] + dice[1];
      p.position = total % BOARD.length;
      if (total >= BOARD.length) {
        p.cash += GO_REWARD;
        this.log(`${p.name} 经过起点，收取 ${GO_REWARD} 万`, "money");
      }
      this.emit({ type: "move", playerId: p.id, position: p.position, dice });
      const space = spaceAt(this.state, p.position);
      this.log(`${p.name} 落在「${space.name}」`, "move");
      this.pushState();
      await this.resolveLanding(p, space, dice);
      return { ok: true };
    }
    p.jailTurns++;
    this.log(`${p.name} 掷出 ${dice[0]}+${dice[1]}，没碰上双数，继续蹲（已蹲 ${p.jailTurns} 回合）`, "warn");
    if (p.jailTurns >= 3) {
      this.log(`${p.name} 蹲满三回合，被迫交保释金`, "money");
      if (p.cash >= JAIL_FEE) {
        p.cash -= JAIL_FEE;
        p.jailed = false;
        p.jailTurns = 0;
      }
    }
    this.pushState();
    await this.endOfRoll(p);
    return { ok: true };
  }

  async aiJailTurn(p) {
    this.busy = true;
    // AI 看守所策略：现金充足就保释，蹲满两次必保；否则赌一把
    const willPay = p.cash >= JAIL_FEE * 8 || p.jailTurns >= 1;
    if (willPay && p.cash >= JAIL_FEE) {
      this.doJailPay(p);
      if (this.state.over) return;
      await this.rollAndResolve(p);
    } else {
      await this.jailRollOnce(p);
    }
  }

  sendToJail(p) {
    p.position = 10;
    p.jailed = true;
    p.jailTurns = 0;
    this.state.turn.canRoll = false;
  }

  // ---------- 落地结算 ----------
  async resolveLanding(p, space, dice) {
    const buyable = ["property", "station", "utility"].includes(space.type);

    if (space.type === "tax") {
      p.cash -= TAX;
      this.log(`${p.name} 交所得税 ${TAX} 万`, "money");
      await this.checkSolvency(p);
      this.pushState();
    } else if (space.type === "gojail") {
      this.log(`${p.name} 落在「入狱！」，直接送进看守所`, "bad");
      this.sendToJail(p);
      this.pushState();
    } else if (space.type === "jail") {
      this.log(`${p.name} 到看守所探监，相安无事`, "info");
    } else if (space.type === "chance" || space.type === "fate") {
      await this.drawCard(p, space.type);
      // drawCard 内部完成后会调用 resolveTail，直接返回
      return;
    } else if (buyable) {
      if (space.owner === "bank") {
        this.state.turn.awaitingBuy = { spaceIdx: space.idx, price: space.price };
      } else if (space.owner !== p.id) {
        const rent = rentFor(this.state, space, dice || [1, 1]);
        const landlord = this.state.players.find((x) => x.id === space.owner);
        p.cash -= rent;
        p.stats.rentPaid += rent;
        landlord.cash += rent;
        landlord.stats.rentCollected += rent;
        this.log(
          `${p.name} 踏进 ${landlord.name} 的「${space.name}」，交租金 ${rent} 万${space.building ? `（${BUILDINGS[space.building]}）` : ""}`,
          "rent"
        );
        await this.checkSolvency(p);
        if (this.state.mode === "spectator" && this.state.commentary !== false && rent >= 100) {
          await this.comment(`${p.name} 向 ${landlord.name} 交了 ${rent} 万租金`);
        }
        this.pushState();
      } else {
        this.log(`${p.name} 回到自己的「${space.name}」`, "info");
      }
    }
    await this.resolveTail(p, dice);
  }

  // 落点结算后的收尾：AI 决策 / 玩家选项
  async resolveTail(p, dice) {
    if (this.state.over) return;
    if (this.isAi(p)) {
      if (!this.state.turn.aiResolved) {
        this.state.turn.aiResolved = true;
        await this.runAiDecision(p, dice || this.state.turn.rolled || [1, 1]);
      } else {
        await this.endOfRoll(p);
      }
      return;
    }
    // 人类玩家：等待操作（买/跳 → 建房/结束；或直接建房/结束）
    this.busy = false;
    this.pushState();
  }

  // ---------- 买 / 跳 / 建 ----------
  doBuy(p) {
    const awaiting = this.state.turn.awaitingBuy;
    if (!awaiting) return { ok: false, msg: "没有待购地块" };
    const space = spaceAt(this.state, awaiting.spaceIdx);
    if (space.owner !== "bank") { this.state.turn.awaitingBuy = null; return { ok: false, msg: "地块已被买走" }; }
    if (p.cash < space.price) return { ok: false, msg: "现金不足" };
    p.cash -= space.price;
    space.owner = p.id;
    p.stats.bought++;
    this.state.turn.awaitingBuy = null;
    this.log(`${p.name} 以 ${space.price} 万买下「${space.name}」${GROUPS[space.group]?.name ? `（${GROUPS[space.group].name}）` : ""}`, "buy");
    this.pushState();
    // 人类买完后进入选项阶段
    if (!this.isAi(p)) { this.busy = false; this.pushState(); }
    return { ok: true };
  }

  doSkip(p) {
    if (!this.state.turn.awaitingBuy) return { ok: false, msg: "没有待购地块" };
    const space = spaceAt(this.state, this.state.turn.awaitingBuy.spaceIdx);
    this.state.turn.awaitingBuy = null;
    this.log(`${p.name} 放弃购买「${space.name}」`, "info");
    if (!this.isAi(p)) { this.busy = false; }
    this.pushState();
    return { ok: true };
  }

  doBuild(p, spaceIdx) {
    const space = this.state.spaces.find((s) => s.idx === Number(spaceIdx));
    if (!space) return { ok: false, msg: "地块不存在" };
    if (space.owner !== p.id) return { ok: false, msg: "地块不属于你" };
    if (space.type !== "property") return { ok: false, msg: "此地不能盖房" };
    if (space.building >= 2) return { ok: false, msg: "已是酒店，无法再升级" };
    if (!ownsGroup(this.state, p.id, space.group)) return { ok: false, msg: "需集齐该组全部地块才能盖房" };
    const cost = buildingCost(space);
    if (p.cash < cost) return { ok: false, msg: "现金不足" };
    p.cash -= cost;
    space.building++;
    p.stats.built++;
    this.log(
      `${p.name} 在「${space.name}」${space.building === 1 ? "盖起一栋房" : "把房子加盖成酒店"}，花 ${cost} 万`,
      "buy"
    );
    if (!this.isAi(p)) { this.pushState(); }
    this.pushState();
    return { ok: true };
  }

  // ---------- 机会/命运卡 ----------
  async drawCard(p, kind) {
    this.busy = true;
    this.emit({ type: "card-draw", kind, playerId: p.id, round: this.state.round });
    this.pushState();
    const card = await this.streamText(
      "card",
      { playerId: p.id, round: this.state.round },
      async (send) => {
        const r = await cardAgent(this.state, kind);
        send(r ? JSON.stringify({ title: r.title, text: r.text }).slice(0, 400) : "{}");
        return r;
      }
    );
    if (!card) {
      this.log(`${p.name} 抽卡失效，无事发生`, "warn");
      await this.resolveTail(p);
      return;
    }
    this.state.pendingCard = { ...card, playerId: p.id };
    this.state.cardHistory.push(card);
    if (this.state.cardHistory.length > 20) this.state.cardHistory.shift();
    this.log(`${p.name} 抽到${kind === "chance" ? "机会" : "命运"}卡：「${card.title}」${card.text}`, "card");

    if (card.effect.cash) {
      p.cash += card.effect.cash;
      this.log(`${p.name} ${card.effect.cash > 0 ? "获得" : "损失"} ${Math.abs(card.effect.cash)} 万`, "money");
    }
    if (card.effect.jail) {
      this.sendToJail(p);
      this.log(`${p.name} 被送进看守所`, "bad");
      this.pushState();
      await this.endOfRoll(p);
      return;
    }
    if (card.effect.moveBack) {
      p.position = (p.position - card.effect.moveBack + BOARD.length * 2) % BOARD.length;
      const s2 = spaceAt(this.state, p.position);
      this.log(`${p.name} 后退 ${card.effect.moveBack} 格，落在「${s2.name}」`, "move");
      this.pushState();
      await this.checkSolvency(p);
      // 后退落点继续结算（不会再抽卡 → 不会无限递归）
      if (s2.type !== "chance" && s2.type !== "fate") {
        await this.resolveLanding(p, s2, this.state.turn.rolled);
        return;
      }
    }
    this.pushState();
    await this.resolveTail(p);
  }

  // ---------- 偿付能力 ----------
  async checkSolvency(p) {
    if (p.cash < 0 && !p.isBankrupt) {
      const liq = liquidate(this.state, p);
      liq.sold.forEach((s) => {
        this.log(`${p.name} 被迫变卖「${s.what}」回笼 ${s.refund} 万`, "bad");
      });
      if (liq.bankrupt) {
        p.isBankrupt = true;
        this.log(`💥 ${p.name} 资不抵债，破产出局！旗下地产全部归还银行`, "bad");
        if (this.state.mode === "spectator" && this.state.commentary !== false) {
          await this.comment(`${p.name}破产了。`);
        }
      }
    }
  }

  // ---------- 一掷之后的收尾 ----------
  async endOfRoll(p) {
    if (this.state.over) return;
    // 入狱或破产：直接换人
    if (p.jailed || p.isBankrupt) {
      this.state.turn.doublesChain = 0;
      await this.advance();
      return;
    }
    if (this.state.turn.awaitingBuy) {
      // 还有待决购买（人类）
      this.busy = false;
      this.pushState();
      return;
    }
    // 双数连掷
    if (this.state.turn.doublesChain > 0 && !p.jailed) {
      this.state.turn.canRoll = true;
      this.pushState();
      if (this.isAi(p)) {
        await this.rollAndResolve(p);
      } else {
        this.busy = false;
      }
      return;
    }
    // 人类：等待手动结束回合（可建房/谈判）；AI：立即收尾
    if (this.isAi(p)) {
      await this.advance();
    } else {
      this.busy = false;
      this.pushState();
    }
  }

  async advance() {
    if (this.state.over) return;
    this.busy = true;
    const n = this.state.players.length;
    let next = this.state.currentIdx;
    let guard = 0;
    do {
      next = (next + 1) % n;
      guard++;
      if (guard > n * 2) { await this.endGame(); return; }
    } while (this.state.players[next].isBankrupt);
    if (next <= this.state.currentIdx) this.state.round++;
    this.state.currentIdx = next;

    const alive = this.state.players.filter((x) => !x.isBankrupt);
    if (alive.length <= 1 || this.state.round > MAX_ROUNDS) {
      await this.endGame();
      return;
    }
    this.save();
    await this.beginTurn();
  }

  // ---------- AI 决策（买/建/交易/发言） ----------
  async runAiDecision(p, dice) {
    this.emit({ type: "npc-thinking", playerId: p.id, name: p.name });
    const space = spaceAt(this.state, p.position);
    const buyable = this.state.turn.awaitingBuy;
    const landedText = buyable
      ? `你掷出 ${dice[0]}+${dice[1]}=${dice[0] + dice[1]}，落在「${space.name}」（${GROUPS[space.group]?.name || ""}，地价 ${space.price} 万，无主，租金基数 ${space.rentBase || "—"}）。`
      : p.jailed
        ? `你正在看守所（已蹲 ${p.jailTurns} 回合）。`
        : `你掷出 ${dice[0]}+${dice[1]}=${dice[0] + dice[1]}，落在「${space.name}」（${
            space.owner === p.id ? "你自己的地" : space.owner === "bank" ? "无主" : `归${this.state.players.find((x) => x.id === space.owner)?.name}`
          }${space.building ? `，已有${BUILDINGS[space.building]}` : ""}）。`;

    let parsed = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1200));
        this.emit({ type: "thought-reset", playerId: p.id, name: p.name });
      }
      try {
        const r = await this.streamText(
          "thought",
          { playerId: p.id, name: p.name },
          async (send) => {
            const res = await npcAgent(this.state, p, landedText, send, attempt === 0
              ? { effort: process.env.ATRIA_EFFORT_NPC || "low", maxOutput: 4000 }
              : { effort: "medium", maxOutput: 9000 });
            return res;
          }
        );
        parsed = r?.parsed;
      } catch (e) {
        console.error(`[NPC诊断] ${p.name} 异常:`, e?.message);
      }
    }

    if (!parsed) {
      this.log(`${p.name} 思考故障，按默认策略行动`, "warn");
      if (buyable && p.cash >= space.price) this.doBuy(p);
      else if (buyable) this.doSkip(p);
      await this.endOfRoll(p);
      return;
    }

    if (buyable) {
      if (parsed.buy === true) {
        if (p.cash >= space.price) this.doBuy(p);
        else { this.doSkip(p); this.log(`${p.name} 现金不足，买不起「${space.name}」`, "warn"); }
      } else {
        this.doSkip(p);
      }
    }
    if (parsed.build != null) {
      const target = this.resolveSpace(parsed.build);
      if (target) {
        const r2 = this.doBuild(p, target.idx);
        if (!r2.ok) this.log(`${p.name} 试图在「${target.name}」盖房失败：${r2.msg}`, "warn");
      } else {
        this.log(`${p.name} 想盖房但没找到地块`, "warn");
      }
    }
    if (parsed.remark?.trim()) {
      const to = matchRemarkTarget(this.state, parsed.remark);
      const cleanRemark = String(parsed.remark).replace(/^对[^：:]{1,10}[：:]/, "").trim();
      this.emit({ type: "remark", playerId: p.id, name: p.name, text: cleanRemark, to: to || undefined });
      this.log(`${p.name}${to ? `（对${to}）` : ""}：${cleanRemark}`, "speech");
    }
    if (parsed.memoryNote) {
      p.memory.push({ r: this.state.round, text: String(parsed.memoryNote).slice(0, 200) });
      if (p.memory.length > 30) p.memory.shift();
    }
    if (parsed.relationDelta && typeof parsed.relationDelta === "object") {
      for (const [pid, dv] of Object.entries(parsed.relationDelta)) {
        if (!this.state.players.some((x) => x.id === pid)) continue;
        const d = Math.max(-3, Math.min(3, Number(dv) || 0));
        p.relations = p.relations || {};
        p.relations[pid] = Math.max(-100, Math.min(100, (p.relations[pid] ?? 0) + d));
      }
    }
    if (parsed.dealOffer?.to) {
      const offer = this.makeOffer(p, parsed.dealOffer);
      if (offer) {
        const offeree = this.state.players.find((x) => x.id === offer.to);
        if (offer.to === "you" && this.state.mode === "normal") {
          this.emit({ type: "offer", offer });
          this.log(`💼 ${p.name} 向你提议交易：${offer.text}`, "deal");
          this.pushState();
        } else if (offeree && offeree.kind === "ai") {
          await this.resolveAiOffer(offer);
        }
      }
    }
    if (this.state.mode === "spectator" && this.state.commentary !== false) {
      const notable = buyable || parsed.build != null || parsed.dealOffer;
      if (notable || this.rand() < 0.25) {
        await this.comment(
          `${p.name} 落在「${space.name}」${parsed.buy === true ? "，买下" : parsed.buy === false ? "，没买" : ""}${parsed.remark ? `，说"${parsed.remark}"` : ""}`
        );
      }
    }
    this.pushState();
    await this.endOfRoll(p);
  }

  // ---------- 地块名解析 ----------
  resolveSpace(raw) {
    if (raw == null) return null;
    if (typeof raw === "number") return this.state.spaces.find((s) => s.idx === raw);
    const s = String(raw).trim();
    let hit = this.state.spaces.find((x) => x.name === s);
    if (!hit) hit = this.state.spaces.find((x) => x.name.includes(s) || s.includes(x.name));
    return hit || null;
  }

  // ---------- 交易提案 ----------
  makeOffer(from, raw) {
    const to = raw.to;
    if (!to || !this.state.players.some((p) => p.id === to)) return null;
    const term = raw.term || {};
    const give = (Array.isArray(term.give) ? term.give : [term.give].filter(Boolean))
      .map((x) => this.resolveSpace(x))
      .filter((s) => s && s.owner === from.id);
    const want = (Array.isArray(term.want) ? term.want : [term.want].filter(Boolean))
      .map((x) => this.resolveSpace(x))
      .filter((s) => s && s.owner === to);
    if (!give.length && !want.length) return null;
    const cash = Math.round(Number(term.cash) || 0);
    if (Math.abs(cash) > 20000) return null;
    const offer = {
      id: uid("offer"),
      from: from.id,
      fromName: from.name,
      to,
      text: String(raw.text || "").slice(0, 200),
      term: { give: give.map((s) => s.idx), want: want.map((s) => s.idx), cash },
      round: this.state.round,
    };
    this.state.offers.push(offer);
    return offer;
  }

  async resolveAiOffer(offer) {
    const offeree = this.state.players.find((p) => p.id === offer.to);
    const drop = () => {
      this.state.offers = this.state.offers.filter((o) => o.id !== offer.id);
    };
    if (!offeree || offeree.isBankrupt || offeree.kind === "human") return;
    let gv = 0, wv = 0;
    offer.term.give.forEach((idx) => { gv += propertyV(this.state, idx); });
    offer.term.want.forEach((idx) => { wv += propertyV(this.state, idx); });
    const net = gv - wv - offer.term.cash;
    const base = Math.max(gv, wv, 1);
    const accept = net / base > -0.1 && offeree.cash >= offer.term.cash;
    if (accept) {
      const r = this.executeOffer(offer, "accept-auto");
      if (r.ok) this.log(`🤝 ${offeree.name} 接受了 ${offer.fromName} 的交易：${offer.text}`, "deal");
      else { drop(); this.log(`${offeree.name} 的接受未生效（条件已变化）`, "warn"); }
    } else {
      drop();
      this.log(`🚫 ${offeree.name} 拒绝了 ${offer.fromName} 的提案：「${offer.text}」`, "deal");
    }
    this.pushState();
  }

  decideOffer(offerId, accept) {
    const offer = this.state.offers.find((o) => o.id === offerId);
    if (!offer) return { ok: false, msg: "提案不存在或已过期" };
    if (offer.to !== "you") return { ok: false, msg: "无权决定该提案" };
    if (this.state.round - offer.round > 2) {
      this.state.offers = this.state.offers.filter((o) => o.id !== offerId);
      this.log(`提案过期作废：「${offer.text}」`, "deal");
      this.pushState();
      return { ok: false, msg: "提案已过期" };
    }
    if (accept) {
      const r = this.executeOffer(offer, "accept");
      if (r.ok) this.log(`🤝 你接受了 ${offer.fromName} 的交易：${offer.text}`, "deal");
      else this.log(`交易未能执行（条件已变化）`, "warn");
    } else {
      this.state.offers = this.state.offers.filter((o) => o.id !== offerId);
      this.emit({ type: "offer-result", offerId, how: "reject" });
      this.log(`🚫 你拒绝了 ${offer.fromName} 的提案：「${offer.text}」`, "deal");
    }
    this.pushState();
    return { ok: true };
  }

  executeOffer(offer, how = "accept") {
    for (const idx of offer.term.give) {
      const s = this.state.spaces.find((x) => x.idx === idx);
      if (!s || s.owner !== offer.from) return { ok: false };
    }
    for (const idx of offer.term.want) {
      const s = this.state.spaces.find((x) => x.idx === idx);
      if (!s || s.owner !== offer.to) return { ok: false };
    }
    const offeree = this.state.players.find((p) => p.id === offer.to);
    if (!offeree || offeree.cash < offer.term.cash) return { ok: false };
    const offerer = this.state.players.find((p) => p.id === offer.from);
    offer.term.give.forEach((idx) => { this.state.spaces.find((x) => x.idx === idx).owner = offer.to; });
    offer.term.want.forEach((idx) => { this.state.spaces.find((x) => x.idx === idx).owner = offer.from; });
    offeree.cash -= offer.term.cash;
    offerer.cash += offer.term.cash;
    this.state.offers = this.state.offers.filter((o) => o.id !== offer.id);
    this.emit({ type: "offer-result", offerId: offer.id, how });
    return { ok: true };
  }

  // ---------- 自由谈判 ----------
  async negotiate(npcId, text) {
    const npc = this.state.players.find((p) => p.id === npcId);
    const me = this.state.players[this.state.currentIdx];
    if (!npc || npc.kind !== "ai" || npc.isBankrupt) return { ok: false, msg: "谈判对象不可用" };
    if (this.state.over) return { ok: false, msg: "本局已结束" };
    if (!me || me.kind !== "human" || me.isBankrupt) return { ok: false, msg: "当前不是你的回合" };
    if (this.state.phase !== "turn") return { ok: false, msg: "只能在你的回合谈判" };
    if (this.busy) return { ok: false, msg: "等待当前动作完成" };
    if (this.state.negotiatedThisTurn?.[npcId]) return { ok: false, msg: "本回合已和 ta 谈过一轮" };
    this.state.negotiatedThisTurn = this.state.negotiatedThisTurn || {};
    this.state.negotiatedThisTurn[npcId] = true;

    const thread = this.state.negotiationLog[npcId] || [];
    thread.push({ role: "player", text });
    this.emit({ type: "negotiation-msg", npcId, role: "player", text });

    let parsed = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        const r = await this.streamText("negotiation", { npcId, name: npc.name }, async (send) => {
          const res = await negotiationAgent(this.state, npc, thread, send, attempt === 0 ? { effort: "low", maxOutput: 3000 } : { effort: "medium", maxOutput: 6000 });
          return res;
        });
        parsed = r?.parsed;
      } catch (e) {
        console.error(`[谈判诊断] ${npc.name}:`, e?.message);
      }
      if (!parsed) this.emit({ type: "text-reset", channel: "negotiation", npcId, name: npc.name });
    }

    if (!parsed) {
      thread.push({ role: "npc", text: "（不想说话，转身走了）" });
      return { ok: false, msg: "谈判失败" };
    }
    const say = String(parsed.say ?? "").slice(0, 300);
    thread.push({ role: "npc", text: say });
    if (thread.length > 24) thread.splice(0, thread.length - 24);
    this.state.negotiationLog[npcId] = thread;
    this.emit({ type: "negotiation-stance", npcId, stance: parsed.stance });
    this.log(`${npc.name}对你说：${say}`, "speech");

    if (parsed.relationDelta?.you !== undefined) {
      const d = Math.max(-3, Math.min(3, Number(parsed.relationDelta.you) || 0));
      npc.relations = npc.relations || {};
      npc.relations.you = Math.max(-100, Math.min(100, (npc.relations.you ?? 0) + d));
    }
    if (parsed.memoryNote) {
      npc.memory.push({ r: this.state.round, text: String(parsed.memoryNote).slice(0, 200) });
      if (npc.memory.length > 30) npc.memory.shift();
    }
    if (parsed.newDealOffer?.term) {
      const offer = this.makeOffer(npc, { to: "you", text: parsed.newDealOffer.text || say, term: parsed.newDealOffer.term });
      if (offer) {
        this.emit({ type: "offer", offer });
        this.log(`💼 ${npc.name} 正式提案：${offer.text}`, "deal");
      }
    }
    this.pushState();
    return { ok: true, say, stance: parsed.stance };
  }

  // ---------- 解说员 ----------
  async comment(contextText) {
    try {
      await this.streamText("commentary", { round: this.state.round }, async (send) => {
        await commentatorAgent(this.state, contextText, send);
      });
    } catch {}
  }

  // ---------- 终局 ----------
  async endGame() {
    if (this.ending) return;
    this.ending = true;
    this.state.over = true;
    this.state.phase = "over";
    const ranked = standings(this.state);
    this.state.ranking = ranked;
    this.emit({ type: "phase", phase: "over" });
    this.pushState();

    for (let i = 0; i < ranked.length; i++) {
      const s = ranked[i];
      const p = this.state.players.find((x) => x.id === s.id);
      try {
        let acc = "";
        await this.streamText("epilogue", { playerId: s.id, name: s.name, rank: i + 1 }, async (send) => {
          await epilogueAgent(this.state, p, i + 1, (chunk) => { acc += chunk; send(chunk); });
          return acc;
        });
        this.state.epilogues[s.id] = acc;
      } catch {}
    }
    this.emit({ type: "over", ranking: ranked });
    this.save();
    this.ending = false;
  }
}

// remark「对XX：」目标解析
function matchRemarkTarget(state, remark) {
  const m = String(remark).match(/^对(.+?)[：:]/);
  if (!m) return null;
  const t = m[1].trim();
  const p = state.players.find((x) => x.name === t || x.id === t || t.includes(x.name) || x.name.includes(t));
  return p?.name || null;
}

function propertyV(state, idx) {
  const s = state.spaces.find((x) => x.idx === idx);
  if (!s) return 0;
  const bonus = s.building === 1 ? s.price * 0.5 : s.building === 2 ? s.price : 0;
  return Math.round(s.price + bonus);
}
