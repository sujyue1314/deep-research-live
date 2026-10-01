import React, { useEffect, useRef, useState } from "react";
import type { GameEvent } from "./api";
import { JsonFieldReader, createReaders } from "./json-reader";

// ============== 类型 ==============
interface Space {
  idx: number; name: string; type: string; group?: string;
  price?: number; rentBase?: number; amount?: number; desc?: string;
  owner: string; building: number;
}
interface Player {
  id: string; name: string; title: string; color: string; kind: string;
  cash: number; position: number; jailed: boolean; isBankrupt: boolean;
  memory?: any[]; relations?: Record<string, number>;
}
interface LogEntry { r: number; text: string; tone: string; t: number }
interface Offer {
  id: string; from: string; fromName: string; to: string;
  text: string; term: { give: number[]; want: number[]; cash: number }; round: number;
}
interface State {
  id: string; round: number; phase: string; mode: string;
  spaces: Space[]; players: Player[];
  currentIdx: number;
  turn: { canRoll: boolean; doublesChain: number; awaitingBuy: { spaceIdx: number; price: number } | null; rolled: number[] | null; aiResolved: boolean };
  offers: Offer[]; negotiationLog: Record<string, { role: string; text: string }[]>;
  pendingCard: { title: string; text: string; kind: string; playerId: string } | null;
  negotiatedThisTurn: Record<string, boolean>;
  log: LogEntry[]; over: boolean; ranking: any[]; epilogues: Record<string, string>;
  cardHistory: any[];
}
interface ThoughtEntry {
  playerId: string; name: string; title: string; color: string;
  text: string; streaming: boolean; round: string; kind: "thought" | "remark";
}

export const GROUP_META: Record<string, { name: string; color: string }> = {
  yellow: { name: "望江组", color: "#e8b339" },
  lightblue: { name: "银杏组", color: "#7ec8e3" },
  pink: { name: "梧桐组", color: "#e36bae" },
  orange: { name: "外滩组", color: "#e07b39" },
  red: { name: "琉璃厂组", color: "#d94141" },
  green: { name: "云顶组", color: "#4caf7d" },
  station: { name: "车站", color: "#9aa3ad" },
  utility: { name: "公用事业", color: "#26a69a" },
};

const DICE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
const BUILD_ICON = ["", "🏠", "🏨"];

// 棋盘格 → 8x8 网格坐标
export function posToGrid(p: number): { row: number; col: number } {
  if (p === 0) return { row: 7, col: 7 };
  if (p <= 6) return { row: 7, col: 7 - p };
  if (p === 7) return { row: 7, col: 0 };
  if (p <= 13) return { row: 14 - p, col: 0 };
  if (p === 14) return { row: 0, col: 0 };
  if (p <= 20) return { row: 0, col: p - 14 };
  if (p === 21) return { row: 0, col: 7 };
  return { row: p - 21, col: 7 };
}
const ROTATION: Record<string, string> = {
  bottom: "", left: "rotate(90deg)", top: "rotate(180deg)", right: "rotate(-90deg)",
};
function sideOf(p: number): "bottom" | "left" | "top" | "right" {
  if (p === 0) return "bottom";
  if (p <= 7) return "bottom";
  if (p <= 14) return "left";
  if (p <= 21) return "top";
  return "right";
}

// ============== 棋盘 ==============
export function Board({
  state, diceRoll, onSpaceAction, myTurn,
}: {
  state: State; diceRoll: number[] | null;
  onSpaceAction?: (s: Space) => void; myTurn?: boolean;
}) {
  const tokens = state.players.filter((p) => !p.isBankrupt);
  return (
    <div className="board">
      {state.spaces.map((s) => {
        const g = posToGrid(s.idx);
        const here = tokens.filter((p) => p.position === s.idx);
        const group = s.group ? GROUP_META[s.group] : null;
        const owner = s.owner !== "bank" ? state.players.find((p) => p.id === s.owner) : null;
        const isBuyable = onSpaceAction && myTurn && s.owner === "bank" &&
          ["property", "station", "utility"].includes(s.type) &&
          state.turn?.rolled && !state.turn?.awaitingBuy;
        return (
          <div
            key={s.idx}
            className={`cell type-${s.type}` + (here.length ? " has-token" : "")}
            style={{
              gridRow: g.row + 1, gridColumn: g.col + 1,
              ...(group ? { borderColor: group.color } : {}),
            }}
            title={s.name}
          >
            {group && <div className="cell-group" style={{ background: group.color }} />}
            {(s.type === "chance" || s.type === "fate") && <div className="cell-badge">{s.type === "chance" ? "❓" : "🎯"}</div>}
            {(s.type === "jail" || s.type === "gojail") && <div className="cell-badge">{s.type === "jail" ? "🔒" : "⛓️"}</div>}
            {s.type === "go" && <div className="cell-badge">🚩</div>}
            {s.type === "parking" && <div className="cell-badge">🅿️</div>}
            {s.type === "tax" && <div className="cell-badge">🧾</div>}
            <div className="cell-name" style={{ transform: ROTATION[sideOf(s.idx)] }}>{s.name}</div>
            <div className="cell-price">
              {s.price ? `${s.price}万` : s.amount ? `-${s.amount}万` : s.desc?.slice(0, 6) || ""}
            </div>
            {s.building ? <div className="cell-building">{BUILD_ICON[s.building]}</div> : null}
            {owner && <div className="cell-owner" style={{ background: owner.color }} />}
            {here.length > 0 && (
              <div className="cell-tokens">
                {here.map((p) => (
                  <span key={p.id} className="token" style={{ background: p.color }} title={p.name}>
                    {p.name[0]}{p.jailed ? "🔒" : ""}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {/* 中心面板 */}
      <CenterPanel state={state} diceRoll={diceRoll} className="center-cell" />
    </div>
  );
}

export function CenterPanel({ state, diceRoll }: { state: State; diceRoll: number[] | null }) {
  const cur = state.players[state.currentIdx];
  const space = state.spaces[cur?.position ?? 0];
  const rolled = state.turn?.rolled || diceRoll;
  return (
    <div className="center-cell" style={{ gridRow: "2 / span 6", gridColumn: "2 / span 6" }}>
      <div className="center-inner">
        <div className="round-tag">第 {state.round} 回合</div>
        {cur && (
          <div className="current-player" style={{ borderColor: cur.color }}>
            <span className="cp-name" style={{ color: cur.color }}>{cur.name}</span>
            <span className="cp-title">{cur.title}</span>
            <span className="cp-cash">💰 {Math.round(cur.cash)} 万</span>
            {cur.jailed && <span className="cp-jail">⛓️ 看守所</span>}
          </div>
        )}
        {rolled && (
          <div className={"dice-box" + (diceRoll ? " rolling" : "")}>
            <span className="die">{DICE_FACES[(rolled[0] ?? 1) - 1]}</span>
            <span className="die">{DICE_FACES[(rolled[1] ?? 1) - 1]}</span>
            <span className="dice-sum">{(rolled[0] ?? 0) + (rolled[1] ?? 0)}</span>
            {rolled[0] === rolled[1] && <span className="dice-double">双数！再掷一次</span>}
          </div>
        )}
        {space && (
          <div className="cur-space">
            落点：<b>「{space.name}」</b>
            {space.price ? ` · ${space.price}万` : ""}
            {space.building ? ` · ${BUILD_ICON[space.building]}` : ""}
          </div>
        )}
        {state.pendingCard && (
          <div className="card-pop">
            <div className="card-pop-title">
              {state.pendingCard.kind === "chance" ? "❓ 机会卡" : "🎯 命运卡"}：《{state.pendingCard.title}》
            </div>
            <div className="card-pop-text">{state.pendingCard.text}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============== 行动面板 ==============
export function ActionBar({
  state, onAction,
}: {
  state: State; onAction: (a: any) => void;
}) {
  const cur = state.players[state.currentIdx];
  const me = state.players[0];
  if (state.over) return null;
  if (!cur || !me || cur.id !== me.id) {
    return (
      <div className="action-bar waiting">
        {state.mode === "spectator"
          ? "🍿 观战中 · AI 互相算计中…"
          : `⏳ 等待 ${cur?.name ?? "对手"} 行动…`}
      </div>
    );
  }
  const awaiting = state.turn?.awaitingBuy;
  const buyableProps = state.spaces.filter((s) => {
    if (s.owner !== me.id || s.type !== "property" || s.building >= 2) return false;
    const members = state.spaces.filter((x) => x.group === s.group);
    return members.length > 1 && members.every((m) => m.owner === me.id);
  });
  return (
    <div className="action-bar">
      {me.jailed && state.turn?.canRoll && !state.turn?.rolled && (
        <>
          <button className="btn btn-warn" onClick={() => onAction({ type: "jailPay" })}>
            💵 花 50 万保释并掷骰
          </button>
          <button className="btn" onClick={() => onAction({ type: "jailRoll" })}>
            🎲 赌一把：掷双数出狱
          </button>
        </>
      )}
      {!me.jailed && state.turn?.canRoll && !state.turn?.rolled && (
        <button className="btn btn-primary" onClick={() => onAction({ type: "roll" })}>
          🎲 掷骰子
        </button>
      )}
      {awaiting && (
        <>
          <button className="btn btn-buy" onClick={() => onAction({ type: "buy" })} disabled={me.cash < awaiting.price}>
            🏷️ 买入「{state.spaces[awaiting.spaceIdx]?.name}」（{awaiting.price}万）
          </button>
          <button className="btn btn-ghost" onClick={() => onAction({ type: "skip" })}>
            跳过
          </button>
        </>
      )}
      {!state.turn?.canRoll && !awaiting && me.cash >= 0 && (
        <>
          {buyableProps.map((s) => (
            <button key={s.idx} className="btn btn-build" onClick={() => onAction({ type: "build", spaceIdx: s.idx })}>
              {s.building === 0 ? "🏠" : "🏨"} 盖建「{s.name}」({Math.round(s.price! * 0.5)}万)
            </button>
          ))}
          <button className="btn" onClick={() => onAction({ type: "endTurn" })}>
            ⏭️ 结束回合
          </button>
        </>
      )}
      {me.cash < 0 && <span className="warn-text">⚠️ 现金为负：下回合资产将被强平</span>}
    </div>
  );
}

// ============== 玩家条 ==============
export function Standings({ state }: { state: State }) {
  return (
    <div className="standings">
      {state.players.map((p) => {
        const props = state.spaces.filter((s) => s.owner === p.id).length;
        return (
          <div key={p.id} className={"player-chip" + (p.isBankrupt ? " bankrupt" : "")} style={{ borderColor: p.color }}>
            <span className="pc-dot" style={{ background: p.color }} />
            <div className="pc-info">
              <div className="pc-name">
                {p.name}
                {p.jailed && " ⛓️"}
                {p.isBankrupt && " 💀"}
                {state.players[state.currentIdx]?.id === p.id && !p.isBankrupt && <span className="pc-turn">· 行动中</span>}
              </div>
              <div className="pc-sub">
                {p.isBankrupt ? "已破产" : `💰${Math.round(p.cash)}万 · 🏠${props}处`}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============== 独白流（窃听面板） ==============
export function ThoughtFeed({
  entries, thinking,
}: {
  entries: ThoughtEntry[]; thinking: { playerId: string; name: string } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [entries, thinking]);
  return (
    <div className="panel thought-feed">
      <div className="panel-title">🎙️ 窃听面板 <span className="hint">AI 的内心独白与公开发言</span></div>
      <div className="panel-body" ref={ref}>
        {thinking && (
          <div className="thinking-row">
            <span className="dots"><i/><i/><i/></span> {thinking.name} 正在思考…
          </div>
        )}
        {entries.length === 0 && !thinking && <div className="empty">等待第一句心声…</div>}
        {entries.map((e, i) => (
          <div
            key={i}
            className={"feed-item " + e.kind + (e.streaming ? " streaming" : "")}
            style={{ borderLeftColor: e.color }}
          >
            <div className="feed-head">
              <b style={{ color: e.color }}>{e.name}</b>
              <span className="feed-title">{e.title}</span>
              <span className="feed-time">{e.round}</span>
            </div>
            <div className="feed-text">
              {e.kind === "remark" ? "🗣️ " : ""}
              {e.text}
              {e.streaming && <span className="cursor">▍</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============== 事件日志 ==============
const TONE_LABEL: Record<string, string> = {
  roll: "🎲", move: "👣", buy: "🏷️", rent: "💸", money: "💰", bad: "💥",
  card: "🃏", speech: "🗣️", deal: "💼", round: "━━", warn: "⚠️", good: "✨", info: "·",
};
export function LogPanel({ log }: { log: LogEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [log]);
  return (
    <div className="panel log-panel">
      <div className="panel-title">📜 事件流</div>
      <div className="panel-body" ref={ref}>
        {log.slice(-120).map((l, i) => (
          <div key={i} className={"log-line tone-" + l.tone}>
            <span className="log-icon">{TONE_LABEL[l.tone] || "·"}</span>
            <span className="log-text">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============== 交易提案卡 ==============
function termText(state: State, term: { give: number[]; want: number[]; cash: number }) {
  const name = (i: number) => state.spaces.find((s) => s.idx === i)?.name ?? "?";
  const parts: string[] = [];
  if (term.give.length) parts.push(`给出 ${term.give.map(name).join("、")}`);
  if (term.want.length) parts.push(`换取 ${term.want.map(name).join("、")}`);
  if (term.cash > 0) parts.push(`对方再付 ${term.cash} 万`);
  if (term.cash < 0) parts.push(`对方收取 ${-term.cash} 万`);
  return parts.join("，") || "无条件";
}

export function OfferCards({
  state, onDecide,
}: {
  state: State; onDecide: (offerId: string, accept: boolean) => void;
}) {
  const mine = state.offers.filter((o) => o.to === "you");
  if (!mine.length) return null;
  return (
    <div className="offers">
      {mine.map((o) => (
        <div key={o.id} className="offer-card">
          <div className="offer-from">💼 {o.fromName} 的交易提案</div>
          <div className="offer-text">“{o.text}”</div>
          <div className="offer-term">条款：{termText(state, o.term)}</div>
          <div className="offer-btns">
            <button className="btn btn-buy" onClick={() => onDecide(o.id, true)}>接受</button>
            <button className="btn btn-ghost" onClick={() => onDecide(o.id, false)}>拒绝</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============== 谈判入口 ==============
export function NegotiationEntry({
  state, onOpen,
}: {
  state: State; onOpen: (npcId: string) => void;
}) {
  const me = state.players[0];
  const isTurn = state.players[state.currentIdx]?.id === me?.id && state.phase === "turn";
  const npcs = state.players.filter((p) => p.kind === "ai" && !p.isBankrupt);
  return (
    <div className="neg-entry">
      <div className="neg-title">🤝 找人谈判 <span className="hint">每回合每人一次，说的话会被记住</span></div>
      <div className="neg-peers">
        {npcs.map((p) => {
          const done = state.negotiatedThisTurn?.[p.id];
          return (
            <button
              key={p.id}
              className="neg-peer" style={{ borderColor: p.color }}
              disabled={!isTurn || !!done}
              onClick={() => onOpen(p.id)}
            >
              <span className="pc-dot" style={{ background: p.color }} />
              {p.name}
              {done ? " ✓已谈" : ""}
            </button>
          );
        })}
      </div>
      {!isTurn && <div className="hint">轮到你时可以开梣谈判</div>}
    </div>
  );
}

// ============== 谈判弹窗 ==============
export function NegotiationModal({
  state, npcId, onClose, streamText,
}: {
  state: State; npcId: string | null; onClose: () => void; streamText: string;
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const readersRef = useRef(createReaders());
  const npc = state.players.find((p) => p.id === npcId);
  const thread = state.negotiationLog[npcId || ""] || [];

  useEffect(() => {
    setInput("");
    readersRef.current = createReaders();
  }, [npcId]);

  if (!npcId || !npc) return null;

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setSending(true);
    setSayText("");
    try {
      const r = await fetch(`/api/${state.id}/negotiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ npcId, text }),
      });
      const res = await r.json();
      if (!res.ok) alert(res.msg || "谈判失败");
      setInput("");
    } catch {
      alert("网络错误");
    }
    setSending(false);
  };

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-box" style={{ borderColor: npc.color }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head" style={{ background: npc.color + "22" }}>
          <b style={{ color: npc.color }}>{npc.name}</b> · {npc.title}
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="neg-thread">
            {thread.length === 0 && (
              <div className="neg-line npc">
                <b>【{npc.name}】</b>坐下来了。你想谈什么？（例如：把你的梧桐西路卖给我，我出 300 万）
              </div>
            )}
            {thread.map((m, i) => (
              <div key={i} className={"neg-line " + m.role}>
                {m.role === "npc" ? <b>【{npc.name}】</b> : <b>【你】</b>}
                {m.text}
              </div>
            ))}
            {streamText && (
              <div className="neg-line npc typing">
                <b>【{npc.name}】</b>{streamText}
                <span className="cursor">▍</span>
              </div>
            )}
          </div>
          <div className="neg-input">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !sending) send(); }}
              placeholder={`对 ${npc.name} 说…`}
              disabled={sending}
            />
            <button className="btn btn-primary" onClick={send} disabled={sending || !input.trim()}>
              {sending ? "…" : "发送"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============== 终局面板 ==============
export function OverScreen({
  state, epilogueText, onMenu,
}: {
  state: State; epilogueText: Record<string, string>; onMenu: () => void;
}) {
  const ranked = state.ranking || [];
  const winner = ranked.find((r) => !r.isBankrupt);
  return (
    <div className="over-screen">
      <div className="over-headline">
        {winner ? `🏆 ${winner.name} 一统江城棋盘` : "本局结束"}
      </div>
      <div className="over-ranking">
        {ranked.map((r, i) => (
          <div key={r.id} className={"over-rank rank-" + (i + 1)} style={{ borderColor: r.color }}>
            <span className="rank-num">#{i + 1}</span>
            <b style={{ color: r.color }}>{r.name}</b>
            <span className="rank-asset">{r.isBankrupt ? "💀 破产" : `${r.assets} 万`}</span>
            <span className="rank-props">🏠 {r.props} 处</span>
          </div>
        ))}
      </div>
      <div className="over-epilogues">
        {ranked.map((r) => {
          const text = epilogueText[r.id] || state.epilogues?.[r.id] || "";
          if (!text) return null;
          return (
            <div key={r.id} className="epilogue-card" style={{ borderLeftColor: r.color }}>
              <div className="epilogue-title">江城财富榜特稿 · {r.name}</div>
              <div className="epilogue-text">{text}</div>
            </div>
          );
        })}
      </div>
      <button className="btn btn-primary" onClick={onMenu}>再来一局</button>
    </div>
  );
}

// ============== 怎么玩 ==============
export function HowToPlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-box howto" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>怎么玩 · 3 分钟看懂</b>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <ol className="howto-list">
            <li><b>掷骰子</b>：轮到你时点「🎲 掷骰子」，两颗骰子之和就是前进的步数。两个一样的点数叫<b>双数</b>，可以再掷一次（连掷三次会被关进看守所！）。</li>
            <li><b>买地</b>：落在无主的地块上会弹出「买入」按钮，按地价买下；别人买下的地，你踩上去就要<b>交过路费</b>。</li>
            <li><b>集齐一组</b>：同色的地块全部买齐，就能「盖房」（🏠），再升一级变「酒店」（🏨）——过路费翻好几倍。同名组的空地如果归一个人，租金也直接翻倍。</li>
            <li><b>机会与命运</b>：落在 ❓ 或 🎯 格子会抽一张 AI 现场编的卡牌，可能是横财、罚款、后退甚至入狱。</li>
            <li><b>谈判</b>：轮到你时可以点三个对手「谈判」——自由发消息谈交易、结盟、恐吓。他们记得每一句话，坑过的人会还回来。</li>
            <li><b>看守所</b>：落在「入狱！」或抽到入狱卡会被关起来。花 50 万保释，或赌一把掷双数出狱。蹲满三回合强制保释。</li>
            <li><b>破产</b>：现金不够付过路费会被强平资产；资不抵债直接出局。最后一个站着的人（或资产最多的人）获胜。</li>
          </ol>
          <div className="howto-tip">💡 观战模式（🍿）让四个 AI 自己互相算计，加一个毒舌解说员全程点评。</div>
        </div>
      </div>
    </div>
  );
}

export function CommentaryFeed({
  entries,
}: {
  entries: { text: string; round: string; streaming: boolean }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [entries]);
  return (
    <div className="panel commentary">
      <div className="panel-title">📣 解说员 <span className="hint">毒舌点评</span></div>
      <div className="panel-body" ref={ref}>
        {entries.length === 0 && <div className="empty">解说员还没开口…</div>}
        {entries.map((e, i) => (
          <div key={i} className="commentary-item">
            <span className="commentary-quote">{e.text.slice(0, 4)}</span>
            <span className="commentary-time">{e.round}</span>
            <div className="commentary-text">{e.text}{e.streaming && <span className="cursor">▍</span>}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
