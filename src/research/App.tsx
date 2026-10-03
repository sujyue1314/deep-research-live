import { useEffect, useRef, useState } from "react";
import {
  startResearch,
  stopResearch,
  subscribeResearch,
  researchInfo,
  askResearch,
  PRESETS,
  type REvent,
} from "./api";
import { JsonFieldReader } from "../json-reader";
import { Header } from "./components/Header";
import { InputBar } from "./components/InputBar";
import { PlanTree } from "./components/PlanTree";
import { TrajectoryStream } from "./components/TrajectoryStream";
import { EvidenceBoard } from "./components/EvidenceBoard";
import { ReportView } from "./components/ReportView";

export type Phase = "idle" | "running" | "done" | "error";
export type Voice = "investigator" | "skeptic" | "adjudicator";

export interface PlanItem {
  id: string;
  text: string;
  status: "pending" | "active" | "done";
}
export interface Evidence {
  id: string;
  index: number;
  url: string;
  title: string;
  quote: string;
  note: string;
  tier: number;
  tierLabel: string;
  verified: boolean;
  year: number | null;
}
export interface Section {
  index: number;
  heading: string;
  markdown: string;
  markdownFull?: string; // iter-11：section 事件直接携带完整正文，本地打字机按此自播
  streaming: boolean;
  confidence?: string;
  crossVerified?: boolean;
}
export interface Conflict {
  id: number;
  urls: string[];
  description: string;
}
export interface QaItem {
  id: string;
  q: string;
  a: string;
  streaming: boolean;
  note?: string | null;
}
export interface TrajEntry {
  key: string;
  kind:
    | "thought"
    | "tool"
    | "results"
    | "page"
    | "fail"
    | "notice"
    | "conflict"
    | "section"
    | "challenge"
    | "verdict";
  text?: string;
  streaming?: boolean;
  icon?: string;
  url?: string;
  title?: string;
  snippet?: string;
  sub?: { title: string; url: string; snippet: string }[];
  urls?: string[];
  thoughtNo?: number;
  voice?: Voice;
  hasSearch?: boolean;
  cross?: { host: string; count: number; query?: string | null };
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"quick" | "deep" | "strict">("quick");
  const [isMock, setIsMock] = useState(false);
  const [hasKey, setHasKey] = useState(true);
  const [forceMock, setForceMock] = useState(false);

  const [plan, setPlan] = useState<PlanItem[]>([]);
  const [principles, setPrinciples] = useState<string[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [oneLine, setOneLine] = useState<string | null>(null);
  const [qa, setQa] = useState<QaItem[]>([]);
  const [traj, setTraj] = useState<TrajEntry[]>([]);
  const [stats, setStats] = useState({ steps: 0, searches: 0, pages: 0 });
  const [elapsed, setElapsed] = useState(0);
  const [highlightEv, setHighlightEv] = useState<number | null>(null);
  const [citeFocus, setCiteFocus] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // iter-15：完稿舞台——报告接管中栏大阅读区，「全过程」可切回三栏直播布局
  const [stageView, setStageView] = useState<"report" | "process">("process");
  const PLAN_SECTIONS: Record<string, number> = { quick: 4, deep: 7, strict: 5 };
  const stageable =
    (phase === "done" || phase === "error") && (sections.length > 0 || !!oneLine);
  const stageClass = stageable && stageView === "report" ? " rb-grid-stage-report" : "";
  // iter-23：非 idle 收起刊首——idle 保留完整杂志封面（下方本就是空面板），
  // 直播/阅读/回放态压缩顶部固定区，把纵向空间还给三栏与公报
  const compact = phase !== "idle";

  const stepRef = useRef(0);
  const voiceRef = useRef<Voice>("investigator");
  const readersRef = useRef<Record<string, JsonFieldReader>>({});

  const showToast = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 3000);
  };

  /* ---------- 启动时探测模型配置 ---------- */
  useEffect(() => {
    researchInfo()
      .then((info) => {
        setHasKey(!!info.hasKey);
        if (!info.hasKey) showToast("未检测到模型密钥，将以「演练模式」运行");
      })
      .catch(() => {});
  }, []);

  /* ---------- 分享链接回放：?session=<id> 直接订阅（不调 start） ---------- */
  const [isReplay, setIsReplay] = useState(false); // iter-14：回放不触发 qa 滚动等「直播专属」行为
  useEffect(() => {
    const sid = new URLSearchParams(window.location.search).get("session");
    if (!sid) return;
    setIsReplay(true);
    setSessionId(sid);
    setPhase("running"); // 占位，state 事件到达后校正
    setElapsed(0);
  }, []);

  /* ---------- 报告打字机（iter-11） ----------
     服务端不再逐帧推 section-chunk（关闭会时会截断末节），改为 section 事件
     携带完整正文，前端按 markdownFull 自播；旧回放的 chunk 仍兼容追加 */
  useEffect(() => {
    const t = setInterval(() => {
      setSections((ss) => {
        let changed = false;
        const next = ss.map((s) => {
          if (!s.markdownFull) return s;
          if (s.markdown.length >= s.markdownFull.length) {
            if (s.streaming) {
              changed = true;
              return { ...s, streaming: false };
            }
            return s;
          }
          changed = true;
          return { ...s, markdown: s.markdownFull.slice(0, s.markdown.length + 24) };
        });
        return changed ? next : ss;
      });
    }, 45);
    return () => clearInterval(t);
  }, []);

  /* ---------- SSE 事件流 ---------- */
  useEffect(() => {
    if (!sessionId) return;
    const getReader = (n: number) => {
      const key = `s${n}`;
      if (!readersRef.current[key]) readersRef.current[key] = new JsonFieldReader("thought");
      return readersRef.current[key];
    };

    const pushTraj = (e: Omit<TrajEntry, "key">) => {
      setTraj((ts) => [...ts, { ...e, key: `${e.kind}_${ts.length}` }]);
    };

    const unsub = subscribeResearch(sessionId, (e: REvent) => {
      switch (e.type) {
        case "state": {
          const s = e.state;
          setPhase(s.phase === "error" ? "error" : s.phase === "done" ? "done" : "running");
          if (s.question) setQuestion(s.question);
          if (typeof s.mock === "boolean") setIsMock(s.mock);
          // iter-21：回放时恢复会话真实调查模式——否则 strict 会话的公报文号头
          // 会错显示「快查」（mode 是本地 state，默认 quick）
          if (isReplay && s.mode) setMode(s.mode);
          // iter-14：计时显示真实用时 —— 完稿用 durationSec；直播分享链接回放用 createdAt 对齐
          if (typeof s.durationSec === "number") setElapsed(s.durationSec);
          else if (s.phase === "running" && typeof s.createdAt === "number")
            setElapsed(Math.max(0, Math.round((Date.now() - s.createdAt) / 1000)));
          setPlan(s.plan || []);
          setPrinciples(s.principles || []);
          setEvidence(s.evidence || []);
          setSections(
            (s.sections || []).map((x: any) => ({
              ...x,
              markdownFull: x.markdownFull ?? x.markdown, // 回放/重连直接以全文展示
              streaming: false,
            })),
          );
          setConflicts(s.conflicts || []);
          setOneLine(s.oneLine || null);
          setStats(s.stats || { steps: 0, searches: 0, pages: 0 });
          setQa((s.qa || []).map((x: any) => ({ ...x, streaming: false })));
          break;
        }
        case "step": {
          // 新一步思路开始：前一条思路收尾
          stepRef.current = e.n;
          voiceRef.current = (e.voice as Voice) || "investigator";
          getReader(e.n).reset();
          setStats((s) => ({ ...s, steps: Math.max(s.steps, e.n) }));
          setTraj((ts) => {
            const cp = [...ts];
            const last = cp[cp.length - 1];
            if (last && last.streaming) cp[cp.length - 1] = { ...last, streaming: false };
            return cp;
          });
          break;
        }
        case "text-chunk": {
          const reader = getReader(stepRef.current);
          const piece = reader.push(e.chunk as string);
          if (!piece) break;
          setTraj((ts) => {
            const last = ts[ts.length - 1];
            if (last && last.kind === "thought" && last.streaming) {
              const cp = [...ts];
              cp[cp.length - 1] = { ...last, text: last.text + piece };
              return cp;
            }
            return [
              ...ts,
              {
                key: `t_${ts.length}`,
                kind: "thought",
                text: piece,
                streaming: true,
                thoughtNo: stepRef.current,
                voice: voiceRef.current,
              },
            ];
          });
          break;
        }
        case "text-done": {
          setTraj((ts) => {
            const cp = [...ts];
            const last = cp[cp.length - 1];
            if (last && last.streaming) cp[cp.length - 1] = { ...last, streaming: false };
            return cp;
          });
          break;
        }
        case "principles":
          setPrinciples(e.items as string[]);
          break;
        case "plan":
          setPlan(e.items);
          break;
        case "search":
          setStats((s) => ({ ...s, searches: s.searches + 1 }));
          pushTraj({ kind: "tool", text: `搜索「${e.query}」`, voice: e.voice });
          break;
        case "search-results":
          pushTraj({
            kind: "results",
            text: `搜索结果（${e.provider}）`,
            sub: e.results,
            voice: e.voice,
          });
          break;
        case "page-open":
          setStats((s) => ({ ...s, pages: s.pages + 1 }));
          pushTraj({ kind: "tool", text: "打开页面", url: e.url });
          break;
        case "page-read":
          pushTraj({
            kind: "page",
            title: e.title,
            url: e.url,
            snippet: e.snippet,
          });
          break;
        case "page-fail":
          pushTraj({ kind: "fail", text: `读取失败：${e.message}`, url: e.url });
          break;
        case "evidence":
          setEvidence((ev) => [
            ...ev,
            {
              id: e.id,
              index: e.index,
              url: e.url,
              title: e.title,
              quote: e.quote,
              note: e.note,
              tier: e.tier,
              tierLabel: e.tierLabel,
              verified: e.verified,
              year: e.year,
            },
          ]);
          pushTraj({
            kind: "tool",
            text: `固定证据 #${e.index}：${e.title}`,
          });
          break;
        case "challenge":
          pushTraj({
            kind: "challenge",
            text: e.text,
            voice: "skeptic",
            hasSearch: e.hasSearch,
            cross:
              e.kind === "diversity"
                ? { host: e.host, count: e.count, query: e.query ?? null }
                : undefined,
          });
          break;
        case "verdict":
          pushTraj({ kind: "verdict", text: e.text, voice: "adjudicator" });
          break;
        case "conflict":
          setConflicts((cs) => [
            ...cs,
            { id: e.id, urls: e.urls, description: e.description },
          ]);
          pushTraj({ kind: "conflict", text: e.description, urls: e.urls });
          break;
        case "section": {
          const full = typeof e.markdown === "string" ? (e.markdown as string) : null;
          setSections((ss) => {
            if (ss.some((x) => x.index === e.index)) return ss; // 同节重复下发时去重
            return [
              ...ss,
              {
                index: e.index,
                heading: e.heading,
                markdown: full ?? "",
                markdownFull: full ?? undefined,
                streaming: true,
                confidence: e.confidence,
                crossVerified: e.crossVerified,
              },
            ];
          });
          pushTraj({
            kind: "section",
            text: `撰写第 ${e.index} 节「${e.heading}」`,
          });
          break;
        }
        case "section-chunk":
          // iter-11 兼容旧回放：仅当节没有完整正文时才追加分帧
          setSections((ss) =>
            ss.map((s) =>
              s.index === e.index && !s.markdownFull
                ? { ...s, markdown: s.markdown + e.chunk }
                : s,
            ),
          );
          break;
        case "one-line":
          setOneLine(e.text);
          break;
        case "qa-q":
          // iter-14：SSE 回放会重发事件流，state 快照之后 qa-q 再达会重复。
          // 已存在则重置该条（与 qa-note 重流语义一致），不存在才新增
          setQa((qs) =>
            qs.some((x) => x.id === e.id)
              ? qs.map((x) => (x.id === e.id ? { ...x, a: "", note: null, streaming: true } : x))
              : [...qs, { id: e.id as string, q: e.q as string, a: "", streaming: true }],
          );
          break;
        case "qa-note":
          // 机器诚实性复核打回：清空旧答案重流
          setQa((qs) =>
            qs.map((x) => (x.id === e.id ? { ...x, a: "", note: e.text as string, streaming: true } : x)),
          );
          break;
        case "qa-chunk":
          setQa((qs) => qs.map((x) => (x.id === e.id ? { ...x, a: x.a + (e.chunk as string) } : x)));
          break;
        case "qa-done":
          setQa((qs) => qs.map((x) => (x.id === e.id ? { ...x, streaming: false } : x)));
          break;
        case "notice":
          pushTraj({ kind: "notice", text: e.text });
          break;
        case "stats":
          setStats(e.stats);
          break;
        case "error":
          pushTraj({ kind: "fail", text: e.message });
          break;
        case "done":
          setPhase(e.phase === "error" ? "error" : "done");
          setSections((ss) => ss.map((s) => ({ ...s, streaming: false })));
          break;
      }
    });
    return unsub;
  }, [sessionId]);

  /* ---------- 计时器 ---------- */
  useEffect(() => {
    if (phase !== "running") return;
    const t = setInterval(() => setElapsed((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  /* ---------- iter-15：完稿自动切到报告舞台 ---------- */
  useEffect(() => {
    if (phase === "done" || phase === "error") setStageView("report");
  }, [phase]);

  /* ---------- 开始 / 停止 ---------- */
  const resetSession = () => {
    setPlan([]);
    setPrinciples([]);
    setEvidence([]);
    setSections([]);
    setConflicts([]);
    setOneLine(null);
    setQa([]);
    setTraj([]);
    setStats({ steps: 0, searches: 0, pages: 0 });
    setElapsed(0);
    setHighlightEv(null);
    setCiteFocus(null);
    stepRef.current = 0;
    readersRef.current = {};
    setStageView("process"); // iter-15：新一轮调研回到全过程直播布局
  };

  const handleStart = async () => {
    const q = input.trim();
    if (!q || phase === "running") return;
    resetSession();
    const opts: { mode: string; mock?: boolean } = { mode };
    if (forceMock) opts.mock = true;
    const r = await startResearch(q, opts);
    if (r.error) {
      showToast(`❌ ${r.error}`);
      return;
    }
    setQuestion(r.question);
    setIsMock(!!r.mock);
    setSessionId(r.id);
    setPhase("running");
    setElapsed(0);
  };

  const handleStop = async () => {
    if (!sessionId) return;
    await stopResearch(sessionId).catch(() => {});
    setPhase("done");
  };

  const handleReset = () => {
    setSessionId(null);
    setPhase("idle");
    resetSession();
  };

  const onRandom = () => {
    const p = PRESETS[Math.floor(Math.random() * PRESETS.length)];
    setInput(p);
  };

  const onCiteClick = (n: number) => {
    setHighlightEv(n);
  };

  // 反向联动：点证据卡 → 高亮报告中引用它的 [n]，再点一次取消
  const onCardClick = (n: number) => {
    setCiteFocus((c) => (c === n ? null : n));
  };

  // 报告追问：答案以 qa-* 事件回流（复用 SSE 订阅）
  const onAsk = async (q: string) => {
    if (!sessionId) return;
    const r = await askResearch(sessionId, q).catch(() => ({ error: "网络错误" }));
    if (r.error) showToast(`❌ ${r.error}`);
  };

  return (
    <div className={compact ? "rb-screen rb-compact" : "rb-screen"}>
      <Header
        phase={phase}
        elapsed={elapsed}
        stats={stats}
        isMock={isMock}
        onStop={handleStop}
        showStop={phase === "running"}
        sessionId={sessionId}
        onToast={showToast}
        stageable={stageable}
        stageView={stageView}
        onStageChange={setStageView}
      />
      {/* iter-22：刊首式骨架——输入区上置到报头下方，非 idle 态退化为议题导语 */}
      <InputBar
        value={input}
        setValue={setInput}
        presets={PRESETS}
        onRandom={onRandom}
        mode={mode}
        setMode={setMode}
        phase={phase}
        onStart={handleStart}
        onStop={handleStop}
        onReset={handleReset}
        hasKey={hasKey}
        forceMock={forceMock}
        setForceMock={setForceMock}
        question={question}
      />
      <div className={`rb-grid${stageClass}`}>
        <div className="rb-col rb-col-left">
          <TrajectoryStream entries={traj} phase={phase} />
        </div>
        <div className="rb-col rb-col-center">
          <EvidenceBoard
            question={question}
            evidence={evidence}
            conflicts={conflicts}
            phase={phase}
            highlight={highlightEv}
            onHighlightDone={() => setHighlightEv(null)}
            onCardClick={onCardClick}
            citeFocus={citeFocus}
          />
        </div>
        <div className="rb-col rb-col-right">
          <PlanTree plan={plan} phase={phase} />
          <ReportView
            sections={sections}
            oneLine={oneLine}
            phase={phase}
            planSections={PLAN_SECTIONS[mode] || 4}
            replay={isReplay}
            evidence={evidence}
            conflicts={conflicts}
            sessionId={sessionId}
            mode={mode}
            onCiteClick={onCiteClick}
            citeFocus={citeFocus}
            qa={qa}
            onAsk={onAsk}
          />
        </div>
      </div>
      {toast && <div className="rb-toast">{toast}</div>}
    </div>
  );
}
