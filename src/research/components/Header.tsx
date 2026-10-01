import type { Phase } from "../App";

interface Props {
  phase: Phase;
  elapsed: number;
  stats: { steps: number; searches: number; pages: number };
  isMock: boolean;
  showStop: boolean;
  onStop: () => void;
}

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};

export function Header({ phase, elapsed, stats, isMock, showStop, onStop }: Props) {
  const dot =
    phase === "running" ? "rb-dot-live" : phase === "done" ? "rb-dot-done" : phase === "error" ? "rb-dot-err" : "";
  const label =
    phase === "running" ? "调查进行中" : phase === "done" ? "调查完成" : phase === "error" ? "调查中断" : "待命中";
  return (
    <header className="rb-header">
      <div className="rb-brand">
        <span className="rb-kicker">Atria Dawn Preview · Field Notes</span>
        <h1 className="rb-title">现场调查局</h1>
        <div className="rb-sub">深度研究直播 · LIVE DEEP RESEARCH</div>
      </div>
      <div className="rb-hstats">
        <div className="rb-stat">
          <span className="rb-stat-label">状态</span>
          <span className="rb-stat-val" style={{ fontFamily: "var(--sans)" }}>
            <i className={`rb-dot ${dot}`} />
            {label}
          </span>
        </div>
        <div className="rb-stat">
          <span className="rb-stat-label">计时</span>
          <span className="rb-stat-val">{fmtTime(elapsed)}</span>
        </div>
        <div className="rb-stat">
          <span className="rb-stat-label">步数</span>
          <span className="rb-stat-val">{stats.steps}</span>
        </div>
        <div className="rb-stat">
          <span className="rb-stat-label">搜索</span>
          <span className="rb-stat-val">{stats.searches}</span>
        </div>
        <div className="rb-stat">
          <span className="rb-stat-label">阅读</span>
          <span className="rb-stat-val">{stats.pages}</span>
        </div>
        {isMock && <span className="rb-badge rb-badge-mock">演练数据</span>}
      </div>
      {showStop && (
        <button className="rb-btn rb-btn-stop" onClick={onStop}>
          停止调查
        </button>
      )}
    </header>
  );
}
