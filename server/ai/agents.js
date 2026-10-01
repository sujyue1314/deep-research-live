// 经典大富翁版 AI 智能体：机会命运卡 / NPC 决策 / 自由谈判 / 解说员 / 人物志
// 剧剧式输出为流式文本；决策性输出为 JSON。
import { responsesJsonStream, responsesStream } from "./client.js";
import {
  BOARD, GROUPS, BUILDINGS, spaceAt, groupMembers, ownsGroup,
  netAssets, rentFor, currentPlayer,
} from "../engine/world.js";

// ---------- 棋盘快照（喂给模型，压缩行） ----------
function tokenOf(state, ownerId) {
  if (ownerId === "bank") return "银行";
  const p = state.players.find((x) => x.id === ownerId);
  return p ? p.name : "?";
}

// 玩家的完整持仓（公开信息）
export function holdingsText(state, playerId) {
  const mine = state.spaces.filter((s) => s.owner === playerId);
  if (!mine.length) return "（无地产）";
  return mine
    .map((s) => {
      const g = GROUPS[s.group];
      const full = ownsGroup(state, playerId, s.group) ? "[集齐]" : "";
      return `${s.name}(${g ? g.name : ""}${BUILDINGS[s.building]}${full})`;
    })
    .join("，");
}

// 全场快照：所有玩家现金/资产/持仓
export function boardText(state) {
  const lines = state.players.map((p) => {
    const st = p.isBankrupt ? "【已破产】" : p.jailed ? "【看守所】" : "";
    return `${p.name} 现金${Math.round(p.cash)}万/资产${netAssets(state, p)}万${st}：${holdingsText(state, p.id)}`;
  });
  const unowned = state.spaces
    .filter((s) => (s.type === "property" || s.type === "station" || s.type === "utility") && s.owner === "bank")
    .map((s) => `${s.name}（${s.price}万）`);
  return lines.join("\n") + "\n银行尚未卖出：" + (unowned.join("、") || "无");
}

// ---------- ① 机会 / 命运卡 ----------
const CARD_SYSTEM = (kind) => `你是大富翁游戏之江城版的${kind === "chance" ? "机会" : "命运"}卡牌生成器。
只输出一个 JSON：
{"title":"卡牌名（8字内）","text":"卡牌描述（40字内，生动、带点黑色幽默）","effect":{"cash":整数可为负,"moveBack":0或正整数,"jail":false}}
effect 规则：
- cash：现金变动（正得负失），范围 -300 到 +300，通常 ±50~200
- moveBack：后退的格数（0 表示不动；最多 3）
- jail：true 表示直接送去看守所（整局卡牌里极少出现）
历史卡牌（不要重复相同主题）：
%s
生成一张新的${kind === "chance" ? "机会" : "命运"}卡 JSON。`;

export async function cardAgent(state, kind) {
  const hist = (state.cardHistory || [])
    .slice(-6)
    .map((c) => `《${c.title}》${c.text}`)
    .join("；");
  const r = await responsesJsonStream(
    {
      system: CARD_SYSTEM(kind).replace("%s", hist || "（暂无）"),
      user: `当前第 ${state.round} 回合。生成一张${kind === "chance" ? "机会" : "命运"}卡。`,
      maxOutput: 800,
      effort: "low",
    },
    () => {}
  );
  const p = r.parsed?.effect && typeof r.parsed === "object" ? r.parsed : null;
  if (!p) return null;
  const effect = p.effect || {};
  return {
    title: String(p.title || "无名卡").slice(0, 20),
    text: String(p.text || "").slice(0, 80),
    kind,
    effect: {
      cash: Math.max(-300, Math.min(300, Number(effect.cash) || 0)),
      moveBack: Math.max(0, Math.min(3, Number(effect.moveBack) || 0)),
      jail: !!effect.jail,
    },
  };
}

// ---------- ② NPC 回合决策 ----------
export async function npcAgent(state, player, landedText, onText, opts = {}) {
  const p = player;
  const others = state.players
    .filter((x) => x.id !== p.id && !x.isBankrupt)
    .map((x) => `${x.name}(${x.title},资产${netAssets(state, x)}万)`)
    .join("，");

  const system = `你是"${p.name}"（${p.title}）：江城大富翁对局中的炒家。
${p.bio}
你的牌风：${p.strategy}
对手：${others}
只输出一个 JSON 对象，不要其他文字：
{"thought":"130字内第一人称内心独白（情绪+算计+具体的牌/钱/人名/恩怨；旁观者唯一能看到你思考的窗口）","buy":true或false,"build":要升级的地块名或null,"jailPay":true或false,"remark":"50字内公开发言（可阴阳/嘲讽/示好/放狠话），可前缀「对XX：」","memoryNote":"一条要记住的事","relationDelta":{"you":-3到+3,..}或{},"dealOffer":null}`;

  const user = `第 ${state.round} 回合，轮到你。
${landedText}
你的账本：现金${Math.round(p.cash)}万；位置=${p.position}号格${spaceAt(state, p.position).name}${p.jailed ? "（在看守所，已蹲${p.jailTurns}回合）".replace("${p.jailTurns}", p.jailTurns) : ""}
你的持仓：${holdingsText(state, p.id)}
全场：
${boardText(state)}
记忆：${p.memory.slice(-6).map((m) => `[R${m.r}] ${m.text}`).join("；") || "（无）"}
观感：${state.players.filter((x) => x.id !== p.id).map((x) => `${x.name}${p.relations?.[x.id] ?? 0}`).join("，")}

可选动作：
- buy：是否买下脚下这块地（价格见上面落点说明）
- build：你在某地块上盖房/升级（仅当你集齐该组全部地块； costs = 地价的一半：房→酒店也是半价；空地变一栋房）
- jailPay：在看守所时是否花 50 万保释出狱
- dealOffer：{"to":"you或玩家id","text":"一句话提案","term":{"give":[你名下的地块名],"want":[对方名下的地块名],"cash":对方向你支付的现金（可负）}}
输出决策 JSON。`;

  const r = await responsesJsonStream(
    {
      system,
      user,
      maxOutput: opts.maxOutput ?? 4000,
      effort: opts.effort || process.env.ATRIA_EFFORT_NPC || "low",
    },
    (chunk, isReasoning) => {
      if (!isReasoning && onText) onText(chunk);
    }
  );
  return { parsed: r.parsed ?? null, content: r.content };
}

// ---------- ③ 谈判（自由文本） ----------
export async function negotiationAgent(state, npc, thread, onText, opts = {}) {
  const messages = [
    {
      role: "system",
      content: `你是"${npc.name}"——${npc.title}，正在大富翁对局中与"你"（新晋土豪）当面谈交易。
${npc.bio}
你的牌风：${npc.strategy}
你对"你"的观感：${npc.relations?.you ?? 0}（-100 敌视…0 中立…+100 信任）
你的持仓：${holdingsText(state, npc.id)}
对方持仓：${holdingsText(state, "you")}
全场：${boardText(state)}

只回复一个 JSON：
{"say":"台词（120字内，符合人设：报价/嘲讽/套话/放狠话/卖惨）","stance":"talk|accept|counter|reject","newDealOffer":null或{"text":"提案描述","term":{"give":[你名下的地块名],"want":[对方地块名],"cash":对方付你的现金（可负）}},"memoryNote":"要记住的事","relationDelta":{"you":-3到+3}}
stance：talk=继续谈；counter=反报价（配 newDealOffer）；accept=接受条件（配 newDealOffer 精确化）；reject=彻底拒绝。
你记得每一笔账，坑过你的人你会在这句话里还回来。只输出 JSON。`,
    },
    ...(thread || []).map((m) => ({
      role: m.role === "npc" ? "assistant" : "user",
      content: m.text,
    })),
  ];
  const r = await responsesJsonStream(
    { messages, maxOutput: opts.maxOutput ?? 3000, effort: opts.effort || "low" },
    (chunk, isReasoning) => {
      if (!isReasoning && onText) onText(chunk);
    }
  );
  return { parsed: r.parsed ?? null, content: r.content };
}

// ---------- ④ 解说员 ----------
export async function commentatorAgent(state, contextText, onText) {
  const user = `你是这场大富翁对局的解说员（毒舌财经评论员风格），用 1~2 句话（60字内）点评刚才发生的这件事。
【盘面】
${boardText(state)}
【事件】${contextText}
直接输出点评，不要 JSON，不要前缀。`;
  return responsesStream(
    { system: "你是嘴毒心黑的解说员，看热闹不嫌事大，点评要一针见血、带梗。", user, maxOutput: 500, effort: "low" },
    (chunk, isReasoning) => {
      if (!isReasoning && onText) onText(chunk);
    }
  );
}

// ---------- ⑤ 终局人物志 ----------
export async function epilogueAgent(state, player, rank, onText) {
  const isWinner = rank === 1 && !player.isBankrupt;
  const user = `终局。请为玩家"${player.name}"（${player.title}）写一段 150~250 字的人物志，刊登在江城财富榜特稿上。
结局数据：第 ${rank} 名${player.isBankrupt ? "；中途破产出局" : ""}；终局资产 ${netAssets(state, player)}万；买入 ${player.stats.bought} 次、盖建 ${player.stats.built} 次、收租 ${Math.round(player.stats.rentCollected)} 万、交租 ${Math.round(player.stats.rentPaid)} 万。
持仓：${holdingsText(state, player.id)}
人物档案：${player.bio}
本局记忆（他的视角）：
${player.memory.slice(-10).map((m) => `[R${m.r}] ${m.text}`).join("\n") || "（无）"}
要求：${isWinner ? "胜者特写——写尽枭雄得志的腔调，但结尾留一句命运的暗讽。" : player.isBankrupt ? "败者特写——破产者的最后独白感，带悲剧美学和黑色幽默。" : "中段玩家的特写——不上不下者的尴尬与算计。"}直接输出正文。`;
  return responsesStream(
    { system: "你是江城财富榜的特稿主笔，擅长把数字写成命运。", user, maxOutput: 1400, effort: "medium" },
    (chunk, isReasoning) => {
      if (!isReasoning && onText) onText(chunk);
    }
  );
}
