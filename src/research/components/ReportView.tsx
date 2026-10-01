import { useLayoutEffect, useRef } from "react";
import type { Section } from "../App";

interface Props {
  sections: Section[];
  oneLine: string | null;
  phase: string;
  evidenceCount: number;
  onCiteClick: (n: number) => void;
  citeFocus: number | null;
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
              {p.slice(2, -2)}
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
        return <span key={i}>{p}</span>;
      })}
    </span>
  );
}

export function ReportView({ sections, oneLine, phase, onCiteClick, citeFocus }: Props) {
  const writing = sections.some((s) => s.streaming);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 反向联动：点证据卡后，滚到报告首次引用该证据处
  useLayoutEffect(() => {
    if (citeFocus == null) return;
    const el = bodyRef.current?.querySelector(".md-cite.hl");
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [citeFocus, sections]);

  return (
    <div className="rb-panel rb-report">
      <div className="rb-panel-head">
        <span>报告 · Report</span>
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
            <span>{oneLine}</span>
          </div>
        )}
        {sections.length === 0 && !oneLine && (
          <div className="rb-empty">
            证据收集完成后，Atria 会在这里撰写带引用编号的结论报告。点击报告中的 [n] 可定位到证据板上对应的原始来源。
          </div>
        )}
        {sections.map((s) => (
          <div className="rp-section" key={s.index}>
            <h3 className="rp-heading">
              <span className="rp-no">{s.index}</span>
              {s.heading}
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
      </div>
    </div>
  );
}
