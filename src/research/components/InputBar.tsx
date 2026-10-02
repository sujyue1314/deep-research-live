import { useRef } from "react";
import type { Phase } from "../App";

interface Props {
  value: string;
  setValue: (s: string) => void;
  presets: string[];
  onRandom: () => void;
  mode: "quick" | "deep" | "strict";
  setMode: (m: "quick" | "deep" | "strict") => void;
  phase: Phase;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  hasKey: boolean;
  forceMock: boolean;
  setForceMock: (b: boolean) => void;
}

export function InputBar({
  value,
  setValue,
  presets,
  onRandom,
  mode,
  setMode,
  phase,
  onStart,
  onStop,
  onReset,
  hasKey,
  forceMock,
  setForceMock,
}: Props) {
  const running = phase === "running";
  const presetRef = useRef<HTMLDivElement | null>(null);
  // iter-15：预设单行横滚的显式翻页（滚轮不横滚、滚动条不可见时，箭头是唯一可达入口）
  const scrollPresets = (dir: number) => {
    const el = presetRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(240, el.clientWidth * 0.6), behavior: "smooth" });
  };
  return (
    <div className="rb-inputbar">
      <div className="ib-row ib-presets-wrap">
        <button
          className="ib-scroll-btn"
          onClick={() => scrollPresets(-1)}
          disabled={running}
          title="前面的灵感"
          aria-label="上一个灵感"
        >
          ‹
        </button>
        <div className="ib-presets" ref={presetRef}>
          {presets.map((p) => (
            <button
              key={p}
              className="ib-chip"
              disabled={running}
              onClick={() => setValue(p)}
              title="点击填入输入框"
            >
              {p}
            </button>
          ))}
          <button className="ib-chip ib-dice" disabled={running} onClick={onRandom}>
            随机灵感
          </button>
        </div>
        <button
          className="ib-scroll-btn"
          onClick={() => scrollPresets(1)}
          disabled={running}
          title="更多灵感"
          aria-label="下一个灵感"
        >
          ›
        </button>
      </div>
      <div className="ib-row ib-main">
        <span className="ib-prefix">研究问题</span>
        <input
          className="ib-input"
          placeholder="输入一个开放研究问题，例如：上海近十年常住人口变化与背后原因"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !running) onStart();
          }}
          disabled={running}
          maxLength={200}
        />
        {!hasKey && (
          <span className="ib-note" title="服务器未配置模型密钥">
            无密钥 · 将运行预制演练
          </span>
        )}
        {hasKey && (
          <label className="ib-mock" title="使用预录轨迹，不调用模型">
            <input
              type="checkbox"
              checked={forceMock}
              onChange={(e) => setForceMock(e.target.checked)}
              disabled={running}
            />
            演练模式
          </label>
        )}
        <div className="ib-mode" title="严格模式：调查员 → 质疑者 → 裁决者三方辩论">
          <button
            className={mode === "quick" ? "ib-seg on" : "ib-seg"}
            disabled={running}
            onClick={() => setMode("quick")}
          >
            快查
          </button>
          <button
            className={mode === "deep" ? "ib-seg on" : "ib-seg"}
            disabled={running}
            onClick={() => setMode("deep")}
          >
            深度
          </button>
          <button
            className={mode === "strict" ? "ib-seg on" : "ib-seg"}
            disabled={running}
            onClick={() => setMode("strict")}
          >
            严格·多智能体
          </button>
        </div>
        {running ? (
          <button className="rb-btn rb-btn-warn" onClick={onStop}>
            停止
          </button>
        ) : phase === "done" || phase === "error" ? (
          <>
            <button className="rb-btn rb-btn-primary" onClick={onStart}>
              换个问题重来
            </button>
            <button className="rb-btn rb-btn-ghost" onClick={onReset}>
              清空
            </button>
          </>
        ) : (
          <button
            className="rb-btn rb-btn-primary"
            onClick={onStart}
            disabled={!value.trim()}
          >
            开始调查
          </button>
        )}
      </div>
    </div>
  );
}
