import type { PlanItem } from "../App";

interface Props {
  plan: PlanItem[];
}

export function PlanTree({ plan }: Props) {
  return (
    <div className="rb-panel rb-plan">
      <div className="rb-panel-head">
        <span>调查计划 · Plan</span>
        <span className="rb-panel-hint">
          {plan.length ? `${plan.filter((p) => p.status === "done").length}/${plan.length} 已完成` : "待拆解"}
        </span>
      </div>
      <div className="rb-plan-list">
        {plan.length === 0 && <span className="rb-empty-sm">开始后 Atria 会先拆解出子问题</span>}
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
