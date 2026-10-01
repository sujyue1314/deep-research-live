import React, { useEffect, useRef, useState, useCallback } from "react";
import { newGame, listGames, startGame, postAction, decideOffer, subscribe, type GameEvent } from "./api";
import { createReaders } from "./json-reader";
import {
  Board, ActionBar, Standings, ThoughtFeed, LogPanel, OfferCards,
  NegotiationEntry, NegotiationModal, CommentaryFeed, OverScreen, HowToPlay,
} from "./panels";
import type { ThoughtEntry } from "./panels";
import "./styles.css";

type Screen = "menu" | "game";

function App() {
  const [screen, setScreen] = useState<Screen>("menu");
  const [state, setState] = useState<any>(null);
  const [phase, setPhase] = useState<string>("");
  const [thinking, setThinking] = useState<{ playerId: string; name: string } | null>(null);
  const [thoughts, setThoughts] = useState<ThoughtEntry[]>([]);
  const [commentary, setCommentary] = useState<{ text: string; round: string; streaming: boolean }[]>([]);
  const [dice, setDice] = useState<number[] | null>(null);
  const [negOpen, setNegOpen] = useState<string | null>(null);
  const [negStream, setNegStream] = useState("");
  const [epiStream, setEpiStream] = useState<Record<string, string>>({});
  const [howto, setHowto] = useState(false);
  const [error, setError] = useState("");
  const [resumeGames, setResumeGames] = useState<any[]>([]);

  const stateRef = useRef<any>(null);
  const readersRef = useRef(createReaders());
  const roundRef = useRef(0);
  stateRef.current = state;
  roundRef.current = state?.round ?? 0;

  // ---------- 事件处理 ----------
  const onEvent = useCallback((e: GameEvent) => {
    switch (e.type) {
      case "state":
        setState(e.state);
        if (e.state?.over) setPhase("over");
        break;
      case "phase":
        setPhase(e.phase || "");
        break;
      case "log":
        setState((st: any) => st ? { ...st, log: e.text ? (st.log || []) : st.log } : st);
        break;
      case "dice": {
        setDice(e.dice || null);
        setTimeout(() => setDice(null), 1800);
        break;
      }
      case "npc-thinking":
        setThinking({ playerId: e.playerId, name: e.name });
        break;
      case "remark": {
        const st = stateRef.current;
        const pl = st?.players?.find((p: any) => p.id === e.playerId);
        setThoughts((ts) => [
          ...ts,
          {
            playerId: e.playerId,
            name: e.name || pl?.name || "?",
            title: pl?.title || "",
            color: pl?.color || "#888",
            text: e.text,
            streaming: false,
            round: `R${roundRef.current}`,
            kind: "remark",
          },
        ]);
        setThinking(null);
        break;
      }
      case "text-chunk": {
        const c = e.channel;
        if (c === "thought") {
          setThinking(null);
          const reader = readersRef.current.get(`t-${e.playerId}`, "thought");
          const piece = reader.push(e.chunk);
          const playerId = e.playerId;
          const name = e.name;
          if (piece) {
            setThoughts((ts) => {
              // 并发流：从后向前找该玩家仍在流式的条目合并
              for (let i = ts.length - 1; i >= Math.max(0, ts.length - 24); i--) {
                if (ts[i].playerId === playerId && ts[i].streaming) {
                  const cp = [...ts];
                  cp[i] = { ...ts[i], text: ts[i].text + piece };
                  return cp;
                }
              }
              const st = stateRef.current;
              const pl = st?.players?.find((p: any) => p.id === playerId);
              return [
                ...ts,
                {
                  playerId,
                  name: name || pl?.name || "?",
                  title: pl?.title || "",
                  color: pl?.color || "#888",
                  text: piece,
                  streaming: true,
                  round: `R${roundRef.current}`,
                  kind: "thought" as const,
                },
              ];
            });
          }
        } else if (c === "negotiation") {
          if (e.npcId === negOpenRef.current) {
            const reader = readersRef.current.get(`n-${e.npcId}`, "say");
            const piece = reader.push(e.chunk);
            if (piece) setNegStream((s) => s + piece);
          }
        } else if (c === "commentary") {
          setCommentary((cs) => {
            const last = cs[cs.length - 1];
            if (last && last.streaming) {
              const cp = [...cs];
              cp[cp.length - 1] = { ...last, text: last.text + e.chunk };
              return cp;
            }
            return [...cs, { text: e.chunk, round: `R${e.round ?? roundRef.current}`, streaming: true }];
          });
        } else if (c === "epilogue") {
          setEpiStream((m) => ({ ...m, [e.playerId]: (m[e.playerId] || "") + e.chunk }));
        }
        break;
      }
      case "text-reset": {
        const c = e.channel;
        if (c === "thought") {
          setThoughts((ts) => ts.filter((t: any) => !(t.playerId === e.playerId && t.streaming)));
          readersRef.current.get(`t-${e.playerId}`, "thought")?.reset();
        } else if (c === "negotiation") {
          setNegStream("");
          readersRef.current.get(`n-${e.npcId}`, "say")?.reset();
        } else if (c === "commentary") {
          setCommentary((cs) => cs.filter((x) => !x.streaming));
        }
        break;
      }
      case "negotiation-msg":
        if (e.role === "npc") {
          setNegStream("");
          readersRef.current.get(`n-${e.npcId}`, "say")?.reset();
        }
        break;
      case "offer":
        // state 里有，无需额外处理
        break;
      default:
        break;
    }
  }, []);

  const negOpenRef = useRef<string | null>(null);
  negOpenRef.current = negOpen;

  // ---------- 开始 / 恢复 ----------
  const begin = useCallback(async (id: string) => {
    setThoughts([]);
    setCommentary([]);
    setEpiStream({});
    setNegStream("");
    setNegOpen(null);
    setError("");
    setState(null);
    setScreen("game");
    await startGame(id);
    const unsub = subscribe(id, onEvent);
    const u = new URL(window.location.href);
    u.searchParams.set("game", id);
    window.history.replaceState({}, "", u.toString());
    return unsub;
  }, [onEvent]);

  const unsubRef = useRef<(() => void) | null>(null);
  useEffect(() => () => unsubRef.current?.(), []);

  const createGame = async (mode: "normal" | "spectator") => {
    const r = await newGame(mode);
    if (!r?.id) {
      setError("开局失败：服务端无响应");
      return;
    }
    unsubRef.current?.();
    unsubRef.current = await begin(r.id);
  };

  const resume = async (id: string) => {
    unsubRef.current?.();
    unsubRef.current = await begin(id);
  };

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("game");
    if (id) {
      begin(id).then((u) => { unsubRef.current = u; });
    } else {
      listGames().then((r) => setResumeGames(r?.games || []));
    }
  }, []);

  // ---------- 行动 ----------
  const onAction = async (a: any) => {
    if (!state?.id) return;
    setError("");
    const r = await postAction(state.id, a);
    if (!r.ok) setError(r.msg || "操作失败");
  };
  const onDecide = async (offerId: string, accept: boolean) => {
    if (!state?.id) return;
    const r = await decideOffer(state.id, offerId, accept);
    if (!r.ok) setError(r.msg || "操作失败");
  };

  // ---------- 渲染 ----------
  if (screen === "menu" && !state) {
    return (
      <div className="app menu-app">
        <div className="menu-box">
          <div className="menu-kicker">ATRIA · 多智能体博弈 Demo</div>
          <h1 className="menu-title">大富翁 · 名利场</h1>
          <div className="menu-sub">经典大富翁规则 + 三个 AI 炒家现场飙戏</div>
          <div className="menu-buttons">
            <button className="btn btn-primary btn-lg" onClick={() => createGame("normal")}>
              🎮 开局：你 vs 三个 AI
            </button>
            <button className="btn btn-lg" onClick={() => createGame("spectator")}>
              🍿 观战：四 AI 互算 + 毒舌解说员
            </button>
          </div>
          <div className="menu-actions">
            <button className="link-btn" onClick={() => setHowto(true)}>❓ 怎么玩</button>
            {resumeGames.length > 0 && (
              <button
                className="link-btn"
                onClick={() => { resume(resumeGames[0].id); }}
              >
                ▶️ 继续上一局（第 {resumeGames[0].round} 回合）
              </button>
            )}
          </div>
          <div className="menu-cast">
            <div className="cast-row"><span style={{ color: "#c9a227" }}>●</span> 郑伯昌 · 老钱收租公 —— 只收租不加杠杆，谁缺钱他五折"帮把手"</div>
            <div className="cast-row"><span style={{ color: "#e05252" }}>●</span> 洪凯文 · 杠杆炒客 —— 敢梭哈敢报价，口头禅"杠杆是第八大奇迹"</div>
            <div className="cast-row"><span style={{ color: "#7b6cf6" }}>●</span> 林曼卿 · 价值派做局者 —— 永远在算别人的底牌</div>
          </div>
        </div>
        {howto && <HowToPlay onClose={() => setHowto(false)} />}
      </div>
    );
  }

  if (!state) {
    return <div className="app loading">载入中…</div>;
  }

  const me = state.players[0];
  const myTurn = state.players[state.currentIdx]?.id === me?.id && me?.kind === "human" && state.mode === "normal";
  const negNpc = negOpen ? state.players.find((p: any) => p.id === negOpen) : null;
  const over = state.over;

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="brand-main">大富翁 · 名利场</span>
          <span className="brand-mode">{state.mode === "spectator" ? "🍿 观战模式" : "🎮 对局模式"}</span>
          <span className="brand-round">第 {state.round} 回合</span>
        </div>
        <Standings state={state} />
      </div>

      <div className="main">
        <div className="left-col">
          {over ? (
            <OverScreen
              state={state}
              epilogueText={epiStream}
              onMenu={() => {
                unsubRef.current?.();
                unsubRef.current = null;
                setState(null);
                setScreen("menu");
                listGames().then((r) => setResumeGames(r?.games || []));
                window.history.replaceState({}, "", window.location.pathname);
              }}
            />
          ) : (
            <Board state={state} diceRoll={dice} />
          )}
          {!over && <ActionBar state={state} onAction={onAction} />}
          {!over && <NegotiationEntry state={state} onOpen={(id) => { setNegOpen(id); setNegStream(""); }} />}
          {!over && <OfferCards state={state} onDecide={onDecide} />}
          {error && <div className="err-toast" onClick={() => setError("")}>⚠️ {error}</div>}
          {!over && !myTurn && state.mode === "normal" && (
            <div className="ai-banner">
              {thinking ? `🧠 ${thinking.name} 正在思考…` : "对手回合中…"}
            </div>
          )}
        </div>
        <div className="right-col">
          {state.mode === "spectator" ? (
            <>
              <ThoughtFeed entries={thoughts} thinking={thinking} />
              <CommentaryFeed entries={commentary} />
            </>
          ) : (
            <ThoughtFeed entries={thoughts} thinking={thinking} />
          )}
          <LogPanel log={state.log || []} />
        </div>
      </div>

      {!over && howto && <HowToPlay onClose={() => setHowto(false)} />}
      {negOpen && negNpc && (
        <NegotiationModal
          state={state}
          npcId={negOpen}
          onClose={() => { setNegOpen(null); setNegStream(""); }}
          streamText={negStream}
        />
      )}
      {!over && (
        <button className="help-fab" title="怎么玩" onClick={() => setHowto(true)}>？</button>
      )}
    </div>
  );
}

export default App;
