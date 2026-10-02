import { useEffect, useState } from "react";
import type { PlanItem } from "../App";

interface Props {
  plan: PlanItem[];
  phase: string;
}

// iter-14：取证阶段展开看进度；完稿后默认收起，把右栏让给报告。
// 用户点过头之后尊重手动选择
export function PlanTree({ plan, phase }: Props) {
  const finished = phase === "done" || phase === "error";
  const [collapsed, setCollapsed] = useState(false);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setCollapsed(finished);
  }, [finished, touched]);

  return (
    <div className="rb-panel rb-plan">
      <button
        className="rb-panel-head rb-plan-toggle"
        onClick={() => {
          setTouched(true);
          setCollapsed((c) => !c);
        }}
        title={collapsed ? "展开查看调查计划" : "收起"}
      >
        <span>调查计划</span>
        <span className="rb-panel-hint">
          {plan.length
            ? `${plan.filter((p) => p.status === "done").length}/${plan.length} 已完成`
            : "待拆解"}
        </span>
        <span className="rb-plan-caret">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <div className="rb-plan-list">
          {plan.length === 0 && <span className="rb-empty-sm">开始后调查员会先拆解出子问题</span>}
          {plan.map((p, i) => (
            <div className={`pl-item pl-${p.status}`} key={p.id}>
              <span className="pl-no">{i + 1}</span>
              <span className="pl-text">{p.text}</span>
              <span className="pl-status">
                {p.status === "done" ? "✓" : p.status === "active" ? "●" : "○"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface PrinciplesProps {
  principles: string[];
}

export function PrinciplesPanel({ principles }: PrinciplesProps) {
  return (
    <div className="rb-panel rb-principles">
      <div className="rb-panel-head">
        <span>第一性要素 · First Principles</span>
      </div>
      <div className="rb-principles-list">
        {principles.length === 0 && (
          <span className="rb-empty-sm">调查员将先论证回答该问题所需的事实基础与口径</span>
        )}
        {principles.map((p, i) => (
          <div className="pr-item" key={i}>
            <span className="pr-no">{i + 1}.</span>
            <span>{p}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
