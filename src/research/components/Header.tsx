import type { Phase } from "../App";

interface Props {
  phase: Phase;
  elapsed: number;
  stats: { steps: number; searches: number; pages: number };
  isMock: boolean;
  showStop: boolean;
  onStop: () => void;
  sessionId: string | null;
  onToast?: (t: string) => void;
}

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};

export function Header({
  phase,
  elapsed,
  stats,
  isMock,
  showStop,
  onStop,
  sessionId,
  onToast,
}: Props) {
  const shareUrl = sessionId ? `${location.origin}${location.pathname}?session=${sessionId}` : null;
  const shareLink = () => {
    if (!shareUrl) return;
    // iter-14：剪贴板 API 不可用（非安全上下文/旧浏览器）时降级提示链接内容
    if (!navigator.clipboard) {
      onToast?.(`不支持自动复制，请手动复制：${shareUrl}`);
      return;
    }
    navigator.clipboard
      .writeText(shareUrl)
      .then(
        () => onToast?.(`分享链接已复制：${shareUrl}`),
        () => onToast?.(`复制失败，请手动复制：${shareUrl}`),
      );
  };
  const dot =
    phase === "running" ? "rb-dot-live" : phase === "done" ? "rb-dot-done" : phase === "error" ? "rb-dot-err" : "";
  const label =
    phase === "running" ? "调查进行中" : phase === "done" ? "调查完成" : phase === "error" ? "调查中断" : "待命中";
  return (
    <header className="rb-header">
      <div className="rb-brand">
        <span className="rb-kicker">现场调查 · 特别报道</span>
        <h1 className="rb-title">现场调查局</h1>
        <div className="rb-sub">深度研究直播 · 全过程公开</div>
      </div>
      <div className="rb-hstats">
        <div className="rb-stat">
          <span className="rb-stat-label">状态</span>
          <span className="rb-stat-val" style={{ fontFamily: "var(--sans)" }}>
            <i className={`rb-dot ${dot}`} />
            {label}
          </span>
        </div>
        {/* iter-14：已完稿且无真实用时（旧回放记录不携带 durationSec）时不显示死钟 */}
        {(phase !== "done" && phase !== "error") || elapsed > 0 ? (
          <div className="rb-stat">
            <span className="rb-stat-label">计时</span>
            <span className="rb-stat-val">{fmtTime(elapsed)}</span>
          </div>
        ) : null}
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
      {sessionId && (
        <button
          className="rb-btn rb-share-btn"
          onClick={shareLink}
          data-share={shareUrl}
          title="复制可分享的回放链接（支持进行中直播与完稿回放）"
        >
          分享
        </button>
      )}
    </header>
  );
}
