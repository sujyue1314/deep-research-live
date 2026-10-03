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
  // iter-15：完稿舞台切换（报告主舞台 ↔ 三栏全过程）
  stageable: boolean;
  stageView: "report" | "process";
  onStageChange: (v: "report" | "process") => void;
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
  stageable,
  stageView,
  onStageChange,
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
  // iter-22 刊首式骨架：报头拆成 masthead（品牌）+ dateline（状态/统计/操作刊号线）
  const noStr = sessionId ? sessionId.replace(/^rs_/, "").slice(0, 12) : "——————";
  return (
    <header className="rb-header">
      <div className="rb-masthead">
        <div className="rb-kicker">现场调查</div>
        <h1 className="rb-title">探照灯</h1>
        <div className="rb-sub">深度研究直播 · 全过程公开</div>
      </div>
      <div className="rb-dateline">
        <div className="rb-hstats">
          <div className="rb-stat rb-stat-live">
            <i className={`rb-dot ${dot}`} />
            <span>{label}</span>
          </div>
          {/* iter-14：已完稿且无真实用时（旧回放记录不携带 durationSec）时不显示死钟 */}
          {(phase !== "done" && phase !== "error") || elapsed > 0 ? (
            <div className="rb-stat">
              计时 <b className="rb-stat-val">{fmtTime(elapsed)}</b>
            </div>
          ) : null}
          <div className="rb-stat">
            步数 <b className="rb-stat-val">{stats.steps}</b>
          </div>
          <div className="rb-stat">
            搜索 <b className="rb-stat-val">{stats.searches}</b>
          </div>
          <div className="rb-stat">
            阅读 <b className="rb-stat-val">{stats.pages}</b>
          </div>
          {isMock && <span className="rb-badge rb-badge-mock">演练数据</span>}
        </div>
        <div className="rb-dl-actions">
          <span className="rb-dl-no mono">No.{noStr}</span>
          {showStop && (
            <button className="rb-btn rb-btn-stop" onClick={onStop}>
              停止调查
            </button>
          )}
          {stageable && (
            // iter-15：完稿后阅读模式切换 —— 报告主舞台（默认）/ 回到三栏全过程
            <div className="rb-stage-switch" role="tablist" aria-label="阅读布局">
              <button
                className={`ib-seg${stageView === "report" ? " on" : ""}`}
                role="tab"
                aria-selected={stageView === "report"}
                onClick={() => onStageChange("report")}
                title="报告接管主阅读区"
              >
                报告
              </button>
              <button
                className={`ib-seg${stageView === "process" ? " on" : ""}`}
                role="tab"
                aria-selected={stageView === "process"}
                onClick={() => onStageChange("process")}
                title="回到三栏全过程"
              >
                全过程
              </button>
            </div>
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
        </div>
      </div>
    </header>
  );
}
