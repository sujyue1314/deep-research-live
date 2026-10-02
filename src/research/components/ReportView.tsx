import { useLayoutEffect, useRef, useState } from "react";
import type { Section, QaItem, Evidence, Conflict } from "../App";

interface Props {
  sections: Section[];
  oneLine: string | null;
  phase: string;
  planSections: number; // iter-15：取证期骨架里显示计划节数
  replay: boolean; // iter-14：回放（?session= 打开）时 questions 到达不抢滚动
  evidence: Evidence[]; // iter-17：附录·证据清单
  conflicts: Conflict[]; // iter-17：分歧与裁决（独立成框）
  sessionId: string | null; // iter-17：文号
  mode: string; // iter-17：调查模式
  onCiteClick: (n: number) => void;
  citeFocus: number | null;
  qa: QaItem[];
  onAsk: (q: string) => void;
}

// C3 排版微调：中英文之间插 thin space（0.2em）、直引号转曲引号（按出现顺序配对）
function typograf(s: string) {
  let openQuote = true;
  // 源码层用 \u2009 转义（thin space），避免文件被工具按普通空格写入
  const spaced = s
    .replace(/(?<=[\u4e00-\u9fa5])(?=[a-zA-Z0-9])/g, "\u2009")
    .replace(/(?<=[a-zA-Z0-9])(?=[\u4e00-\u9fa5])/g, "\u2009");
  return spaced
    .replace(/"/g, () => {
      const c = openQuote ? "“" : "”";
      openQuote = !openQuote;
      return c;
    })
    .replace(/'/g, "’");
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return String(url).slice(0, 36);
  }
}

// iter-21：「多智能体」是 AI 行话——改叫三方会审（调查员取证 → 质疑者开炮 → 裁决者判决）
const MODE_NAME: Record<string, string> = { quick: "快查", deep: "深度", strict: "严格·三方会审" };

// 极简 markdown 渲染：列表行、加粗、[n] 引用条
function renderLine(
  text: string,
  onCite: (n: number) => void,
  key: string,
  citeFocus: number | null,
) {
  const parts = text.split(/(\[\d+(?:\]\[\d+)*\]|\*\*[^*]+\*\*)/g);
  return (
    <span key={key}>
      {parts.map((p, i) => {
        if (/^\*\*[^*]+\*\*$/.test(p)) {
          return (
            <strong key={i} className="md-bold">
              {typograf(p.slice(2, -2))}
            </strong>
          );
        }
        const cite = p.match(/^\[(\d+(?:\]\[\d+)*)\]$/);
        if (cite) {
          const nums = cite[1].split(/\]\[/).map((n) => Number(n));
          // 反向联动：当前聚焦证据的引用常驻高亮
          const hl = citeFocus != null && nums.includes(citeFocus);
          return (
            <button
              key={i}
              className={`md-cite${hl ? " hl" : ""}`}
              onClick={() => onCite(Math.min(...nums))}
              title={`定位到附录证据 #${nums.join("、")}`}
            >
              [{nums.join("][")}]
            </button>
          );
        }
        return <span key={i}>{typograf(p)}</span>;
      })}
    </span>
  );
}

export function ReportView({
  sections,
  oneLine,
  phase,
  planSections,
  replay,
  evidence,
  conflicts,
  sessionId,
  mode,
  onCiteClick,
  citeFocus,
  qa,
  onAsk,
}: Props) {
  const writing = sections.some((s) => s.streaming);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const appendixRef = useRef<HTMLDivElement | null>(null);
  const [qInput, setQInput] = useState("");
  // iter-17：附录证据行的展开（点击或正文引用点击）
  const [expandedEv, setExpandedEv] = useState<number | null>(null);

  // 反向联动：点证据卡后，滚到报告首次引用该证据处
  useLayoutEffect(() => {
    if (citeFocus == null) return;
    const el = bodyRef.current?.querySelector(".md-cite.hl");
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [citeFocus, sections]);

  // 新问答条目进入视图（只在条目数变化时滚，不跟流式 chunk 抢滚动）
  // iter-14：回放批量重放 questions 快照 + 事件时不应滚动——否则分享链接一打开，
  // 报告就被拽到底部追问区，一句话结论被顶出视口
  const qaLenRef = useRef(0);
  useLayoutEffect(() => {
    if (qa.length <= qaLenRef.current) {
      qaLenRef.current = qa.length;
      return;
    }
    qaLenRef.current = qa.length;
    if (replay) return; // 直播/追问才跟随
    const list = bodyRef.current?.querySelector(".qa-list");
    list?.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [qa, replay]);

  const canAsk = phase === "done" && sections.length > 0;
  // 首字下沉候选：一句结论首字符为 CJK 或拉丁字母
  const dcEligible = !!oneLine && /[一-龥A-Za-z]/.test(oneLine[0]);

  // iter-17：引用点击 —— 正文内滚到附录证据行并展开（无论哪个视图），
  // 全过程视图同时闪烁证据卡（旧联动保留）
  const handleCite = (n: number) => {
    setExpandedEv(n);
    requestAnimationFrame(() => {
      const row = bodyRef.current?.querySelector(`[data-evrow="${n}"]`);
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    onCiteClick(n);
  };

  // iter-17：置信摘要（诚实统计，不做加权幻觉）
  const confSummary = (() => {
    if (!sections.length) return "—";
    const high = sections.filter((s) => s.confidence === "高").length;
    const crossed = sections.filter((s) => s.crossVerified).length;
    return `${high}/${sections.length} 节高置信 · ${crossed}/${sections.length} 节跨域名`;
  })();
  const today = new Date();
  const dateStr = `${today.getFullYear()} 年 ${today.getMonth() + 1} 月 ${today.getDate()} 日`;

  return (
    <div className="rb-panel rb-report rb-doc">
      {/* 文号头 */}
      <div className="doc-head">
        <div className="doc-kicker">探照灯 · 调查报告</div>
        <div className="doc-meta mono">
          {"No." + (sessionId ? sessionId.replace(/^rs_/, "").slice(0, 12) : "——————")} · {dateStr} ·{" "}
          {MODE_NAME[mode] || "快查"}
          {phase === "done" ? " · 已完稿" : writing ? " · 撰写中" : ""}
        </div>
        {sections.length > 0 && (
          <button
            className="rb-print-btn doc-print"
            onClick={() => window.print()}
            title="打印或另存为 PDF"
          >
            打印
          </button>
        )}
      </div>
      <div className="rb-report-body" ref={bodyRef}>
        {/* 裁决段：头版式巨型结论 lead */}
        {oneLine && (
          <div className="doc-verdict">
            <div className="doc-verdict-tag">本案结论</div>
            <p className={`doc-verdict-text${dcEligible ? " rp-dc" : ""}`}>{typograf(oneLine)}</p>
            {sections.length > 0 && (
              <div className="doc-verdict-meta">
                置信：{confSummary} · 证据 {evidence.length} 条
                {conflicts.length > 0 ? ` · 分歧 ${conflicts.length} 处` : ""}
              </div>
            )}
          </div>
        )}
        {sections.length === 0 && !oneLine && phase === "running" && (
          // iter-15：取证期报告面板的骨架（带预期），取代原先只有顶部一条提示、
          // 下方整片空白的空态
          <div className="rp-skel">
            <div className="rp-skel-head">取证中 · 完稿后在此撰写报告（共 {planSections} 节计划）</div>
            {[1, 2, 3].map((i) => (
              <div className="rp-skel-sec" key={i}>
                <div className="ev-skel-line ev-skel-w40" />
                <div className="ev-skel-line" />
                <div className="ev-skel-line ev-skel-w80" />
              </div>
            ))}
          </div>
        )}
        {sections.length === 0 && !oneLine && phase !== "running" && (
          <div className="rb-empty">
            证据收集完成后，调查员会在这里撰写带引用编号的结论报告。点击报告中的 [n] 可定位到附录证据清单对应的原始来源。
          </div>
        )}
        {/* 认定事项 */}
        {sections.map((s) => (
          <section className="doc-finding" key={s.index}>
            <h3 className="doc-finding-head">
              <span className="doc-finding-no">认定 {s.index}</span>
              <span className="doc-finding-title">{typograf(s.heading)}</span>
              <span className="doc-finding-badges">
                {s.confidence && (
                  <span className={`rp-badge conf-${s.confidence === "高" ? "high" : s.confidence === "中" ? "mid" : "low"}`}>
                    置信 {s.confidence}
                  </span>
                )}
                {s.crossVerified !== undefined && (
                  <span className={`rp-badge ${s.crossVerified ? "conf-high" : "conf-mid"}`}>
                    {s.crossVerified ? "跨域名" : "单一来源"}
                  </span>
                )}
              </span>
            </h3>
            <div className={`rp-md ${s.streaming ? "streaming" : ""}`}>
              {s.markdown.split("\n").map((line, i) =>
                line.trim() === "" ? (
                  <div className="rp-gap" key={i} />
                ) : (
                  <div className="rp-line" key={i}>
                    {renderLine(line, handleCite, `${s.index}-${i}`, citeFocus)}
                    {s.streaming && i === s.markdown.split("\n").length - 1 && (
                      <span className="tr-caret" />
                    )}
                  </div>
                ),
              )}
            </div>
          </section>
        ))}
        {/* 分歧与裁决（独立成框） */}
        {conflicts.length > 0 && (
          <div className="doc-conflict">
            <div className="doc-conflict-head">分歧与裁决</div>
            {conflicts.map((c) => (
              <div className="doc-conflict-item" key={c.id}>
                <div className="doc-conflict-desc">{typograf(c.description)}</div>
                <div className="doc-conflict-srcs mono">
                  {c.urls.map((u, i) => (
                    <span key={i}>
                      {i + 1}. {hostOf(u)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        {/* 完稿印：环形章戳 */}
        {phase === "done" && sections.length > 0 && (
          <div className="doc-seal">
            <div className="doc-seal-ring">
              <span>探照灯</span>
              <span className="doc-seal-main">完稿</span>
              <span className="mono">{dateStr}</span>
            </div>
          </div>
        )}
        {/* 附录 · 证据清单：正文引用 [n] 指向这里，行可展开引文 */}
        {evidence.length > 0 && (
          <div className="doc-appendix" ref={appendixRef}>
            <div className="doc-appendix-head">附录 · 证据清单</div>
            <div className="doc-ev-table">
              {evidence.map((ev) => {
                const open = expandedEv === ev.index || citeFocus === ev.index;
                return (
                  <div
                    className={`doc-ev-row${open ? " open" : ""}`}
                    key={ev.id}
                    data-evrow={ev.index}
                    onClick={() => setExpandedEv(open ? null : ev.index)}
                    title={open ? "收起引文" : "展开引文"}
                  >
                    <div className="doc-ev-main">
                      <span className="doc-ev-no">[{ev.index}]</span>
                      <div className="doc-ev-title-wrap">
                        <div className="doc-ev-title">{ev.title}</div>
                        <div className="doc-ev-host mono">
                          <a
                            href={ev.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {hostOf(ev.url)} ↗
                          </a>
                        </div>
                      </div>
                      <div className="doc-ev-marks">
                        {ev.tierLabel && <span className={`ev-badge tier-${ev.tier}`}>{ev.tierLabel}</span>}
                        {ev.year && <span className="ev-badge ev-year">{ev.year}</span>}
                        {ev.verified && <span className="ev-badge ev-verified">✓ 核验</span>}
                      </div>
                    </div>
                    {open && (
                      <div className="doc-ev-quote">
                        <div className="doc-ev-q">“{ev.quote}”</div>
                        {ev.note && <div className="doc-ev-note">{ev.note}</div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {/* 答记者问（原 Q&A） */}
        {canAsk && (
          <div className="rb-qa">
            <div className="rb-qa-head">
              <span>答记者问</span>
              <span className="rb-panel-hint">回答仅基于本次固定的证据</span>
            </div>
            <div className="qa-list">
              {qa.map((item) => (
                <div className="qa-item" key={item.id}>
                  {item.note && <div className="qa-note">{item.note}</div>}
                  <div className="qa-q">
                    <span className="qa-tag">问</span>
                    {typograf(item.q)}
                  </div>
                  <div className="qa-a">
                    {renderLine(item.a, handleCite, `qa-${item.id}`, citeFocus)}
                    {item.streaming && <span className="tr-caret" />}
                  </div>
                </div>
              ))}
            </div>
            <form
              className="rb-qa-form"
              onSubmit={(ev) => {
                ev.preventDefault();
                const t = qInput.trim();
                if (!t) return;
                setQInput("");
                onAsk(t);
              }}
            >
              <input
                className="rb-qa-input"
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="就这份证据追问，如：2024 年减少了多少？"
                maxLength={200}
              />
              <button className="rb-qa-send" type="submit" disabled={!qInput.trim()}>
                追问
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
