import { useLayoutEffect, useRef } from "react";
import type { Evidence, Conflict } from "../App";

interface Props {
  question: string;
  evidence: Evidence[];
  conflicts: Conflict[];
  phase: string;
  highlight: number | null;
  onHighlightDone: () => void;
  onCardClick: (n: number) => void;
  citeFocus: number | null;
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return String(url).slice(0, 36);
  }
}

export function EvidenceBoard({
  question,
  evidence,
  conflicts,
  phase,
  highlight,
  onHighlightDone,
  onCardClick,
  citeFocus,
}: Props) {
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // 冲突涉及的证据卡片（红框高亮）
  const conflictedIds = new Set<string>();
  conflicts.forEach((c) => {
    c.urls.forEach((url) => {
      const ev = evidence.find((e) => e.url === url);
      if (ev) conflictedIds.add(ev.id);
    });
  });

  // 引用定位高亮
  useLayoutEffect(() => {
    if (highlight == null) return;
    const ev = evidence.find((e) => e.index === highlight);
    if (!ev) return;
    const el = cardRefs.current[ev.id];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("flash");
      const t = setTimeout(() => {
        el.classList.remove("flash");
        onHighlightDone();
      }, 1600);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight, evidence]);

  return (
    <div className="rb-panel rb-board">
      <div className="rb-panel-head">
        <span>证据</span>
        <span className="rb-panel-hint">
          {evidence.length ? `${evidence.length} 条已固定 · 红框 = 来源冲突` : "等待取证"}
        </span>
      </div>
      <div className="rb-board-body">
        <div className="rb-question">
          <span className="rb-q-text">{question || "（研究问题将列在此处）"}</span>
        </div>
        {conflicts.map((c) => (
          <div className="rb-conflict" key={c.id}>
            <div className="tr-c-head">分歧</div>
            <div className="tr-c-body">{c.description}</div>
            <div className="tr-c-urls mono">
              {c.urls.map((u, i) => (
                <span key={i}>
                  {i + 1}. {hostOf(u)}
                </span>
              ))}
            </div>
          </div>
        ))}
        <div className="rb-cards">
          {evidence.length === 0 && conflicts.length === 0 && phase === "running" && (
            // iter-15：直播取证期给「即将到达」的骨架占位——否则面板下半部全白，
            // 观众无法预期证据的数量与形态
            <>
              {[1, 2, 3, 4].map((i) => (
                <div className="ev-skel" key={i}>
                  <div className="ev-skel-line ev-skel-w40" />
                  <div className="ev-skel-line" />
                  <div className="ev-skel-line ev-skel-w70" />
                  <div className="ev-skel-tag">证据位 {i} · 待固定</div>
                </div>
              ))}
            </>
          )}
          {evidence.length === 0 && conflicts.length === 0 && phase !== "running" && (
            <div className="rb-empty" style={{ gridColumn: "1 / -2" }}>
              调查员固定的证据会列在这张参考文献表上，每条都可点开原始来源。
            </div>
          )}
          {evidence.map((ev) => (
            <div
              className={`ev-card ${conflictedIds.has(ev.id) ? "ev-conflict" : ""} ${
                citeFocus === ev.index ? "ev-active" : ""
              }`}
              key={ev.id}
              ref={(el) => (cardRefs.current[ev.id] = el)}
              onClick={() => onCardClick(ev.index)}
              title="点击联动高亮报告中的引用"
            >
              <a
                className="ev-title"
                href={ev.url}
                target="_blank"
                rel="noopener noreferrer"
                title={ev.url}
                onClick={(e) => e.stopPropagation()}
              >
                <span className="ev-no">{ev.index}</span>
                {ev.title}
              </a>
              <div className="ev-badges">
                {ev.tierLabel && (
                  <span className={`ev-badge tier-${ev.tier}`}>{ev.tierLabel}</span>
                )}
                {ev.verified && (
                  <span className="ev-badge ev-verified" title="引文经机器校验为原文逐字摘录">
                    ✓ 引文已核验
                  </span>
                )}
                {ev.year && <span className="ev-badge ev-year">{ev.year}</span>}
              </div>
              <div className="ev-quote">“{ev.quote}”</div>
              <div className="ev-note">{ev.note}</div>
              <div className="ev-src mono">
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
          ))}
        </div>
      </div>
    </div>
  );
}
