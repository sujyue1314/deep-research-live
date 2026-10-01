import { useEffect, useRef } from "react";
import type { TrajEntry, Voice } from "../App";

interface Props {
  entries: TrajEntry[];
  phase: string;
}

const VOICES: Record<Voice, { ch: string; label: string; cls: string }> = {
  investigator: { ch: "查", label: "调查员", cls: "v-inv" },
  skeptic: { ch: "质", label: "质疑者", cls: "v-skep" },
  adjudicator: { ch: "裁", label: "裁决者", cls: "v-adj" },
};

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

function VoiceTag({ voice }: { voice?: Voice }) {
  const v = VOICES[voice || "investigator"];
  return (
    <span className={`tr-voice ${v.cls}`}>
      <span className="tr-avatar">{v.ch}</span>
      {v.label}
    </span>
  );
}

export function TrajectoryStream({ entries, phase }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  return (
    <div className="rb-panel rb-traj" ref={ref}>
      <div className="rb-panel-head">
        <span>调查直播 · Live</span>
        <span className="rb-panel-hint">{phase === "running" ? "思考与操作实时流出" : "等待开始"}</span>
      </div>
      <div className="rb-traj-list">
        {entries.length === 0 && (
          <div className="rb-empty">输入研究问题后，Atria 的每一步思考、搜索与取证都会流到这里。</div>
        )}
        {entries.map((e) => {
          if (e.kind === "thought") {
            return (
              <div key={e.key} className="tr-thought">
                <div className="tr-th-head">
                  <VoiceTag voice={e.voice} />
                  <span className="tr-step">思路 #{e.thoughtNo}</span>
                </div>
                <div className={`tr-th-text ${e.streaming ? "streaming" : ""}`}>
                  {e.text}
                  {e.streaming && <span className="tr-caret" />}
                </div>
              </div>
            );
          }
          if (e.kind === "challenge") {
            return (
              <div key={e.key} className="tr-challenge">
                <div className="tr-ch-head">
                  <VoiceTag voice="skeptic" />
                  <span className="tr-ch-tag">质 疑</span>
                  {e.hasSearch && <span className="tr-ch-search">已追加搜索查证</span>}
                </div>
                <div className="tr-ch-body">{e.text}</div>
              </div>
            );
          }
          if (e.kind === "verdict") {
            return (
              <div key={e.key} className="tr-verdict">
                <div className="tr-ch-head">
                  <VoiceTag voice="adjudicator" />
                  <span className="tr-ch-tag adj">裁 决</span>
                </div>
                <div className="tr-ch-body">{e.text}</div>
              </div>
            );
          }
          if (e.kind === "results") {
            return (
              <div key={e.key} className="tr-results">
                <div className="tr-r-head">
                  {e.voice ? <VoiceTag voice={e.voice} /> : null} {e.text}
                </div>
                {(e.sub || []).map((r, i) => (
                  <div className="tr-r-item" key={i}>
                    <span className="tr-r-no">{i + 1}</span>
                    <div>
                      <div className="tr-r-title">{r.title}</div>
                      <div className="tr-r-url mono">{hostOf(r.url)}</div>
                    </div>
                  </div>
                ))}
              </div>
            );
          }
          if (e.kind === "page") {
            return (
              <div key={e.key} className="tr-page">
                <div className="tr-p-body">
                  <div className="tr-p-title">{e.title}</div>
                  <div className="tr-r-url mono">{hostOf(e.url || "")}</div>
                  <div className="tr-p-snip">{e.snippet}</div>
                </div>
              </div>
            );
          }
          if (e.kind === "conflict") {
            return (
              <div key={e.key} className="tr-conflict">
                <div className="tr-c-head">分歧 · Dispute</div>
                <div className="tr-c-body">{e.text}</div>
                <div className="tr-c-urls mono">
                  {(e.urls || []).map((u, i) => (
                    <span key={i}>
                      {i + 1}. {hostOf(u)}
                    </span>
                  ))}
                </div>
              </div>
            );
          }
          if (e.kind === "section") {
            return (
              <div key={e.key} className="tr-section">
                {e.text}
              </div>
            );
          }
          // tool / notice / fail
          return (
            <div key={e.key} className={`tr-row tr-${e.kind}`}>
              <span className="tr-icon">{e.icon}</span>
              <span className="tr-row-text">
                {e.text}
                {e.url && <span className="tr-r-url mono"> · {hostOf(e.url)}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
