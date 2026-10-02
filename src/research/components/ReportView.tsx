import { useLayoutEffect, useRef, useState } from "react";
import type { Section, QaItem } from "../App";

interface Props {
  sections: Section[];
  oneLine: string | null;
  phase: string;
  replay: boolean; // iter-14：回放（?session= 打开）时 questions 到达不抢滚动
  evidenceCount: number;
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
              title={`定位到证据 #${nums.join("、")}`}
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

export function ReportView({ sections, oneLine, phase, replay, onCiteClick, citeFocus, qa, onAsk }: Props) {
  const writing = sections.some((s) => s.streaming);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [qInput, setQInput] = useState("");

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

  return (
    <div className="rb-panel rb-report">
      <div className="rb-panel-head">
        <span>报告</span>
        <span className="rb-panel-hint">
          {phase === "done" ? "已完稿" : writing ? "撰写中…" : sections.length ? "取证中…" : "待生成"}
        </span>
        {sections.length > 0 && (
          <button
            className="rb-print-btn"
            onClick={() => window.print()}
            title="打印或另存为 PDF"
          >
            打印
          </button>
        )}
      </div>
      <div className="rb-report-body" ref={bodyRef}>
        {oneLine && (
          <div className="rp-online">
            <span className="rp-online-tag">一句话结论</span>
            <span className={dcEligible ? "rp-dc" : ""}>{typograf(oneLine)}</span>
          </div>
        )}
        {sections.length === 0 && !oneLine && (
          <div className="rb-empty">
            证据收集完成后，调查员会在这里撰写带引用编号的结论报告。点击报告中的 [n] 可定位到证据板上对应的原始来源。
          </div>
        )}
        {sections.map((s) => (
          <div className="rp-section" key={s.index}>
            <h3 className="rp-heading">
              <span className="rp-no">{s.index}</span>
              {typograf(s.heading)}
              <span className="rp-spacer" />
              {s.confidence && (
                <span className={`rp-badge conf-${s.confidence === "高" ? "high" : s.confidence === "中" ? "mid" : "low"}`}>
                  置信度 {s.confidence}
                </span>
              )}
              {s.crossVerified !== undefined && (
                <span className={`rp-badge ${s.crossVerified ? "conf-high" : "conf-mid"}`}>
                  {s.crossVerified ? "交叉验证 ✓" : "单一来源"}
                </span>
              )}
            </h3>
            <div className={`rp-md ${s.streaming ? "streaming" : ""}`}>
              {s.markdown.split("\n").map((line, i) =>
                line.trim() === "" ? (
                  <div className="rp-gap" key={i} />
                ) : (
                  <div className="rp-line" key={i}>
                    {renderLine(line, onCiteClick, `${s.index}-${i}`, citeFocus)}
                    {s.streaming && i === s.markdown.split("\n").length - 1 && (
                      <span className="tr-caret" />
                    )}
                  </div>
                ),
              )}
            </div>
          </div>
        ))}
        {/* 收尾印记：报告完整的编辑式终止符 */}
        {phase === "done" && sections.length > 0 && <div className="rp-end-mark" />}
        {canAsk && (
          <div className="rb-qa">
            <div className="rb-qa-head">
              <span>追问</span>
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
                    {renderLine(item.a, onCiteClick, `qa-${item.id}`, citeFocus)}
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
