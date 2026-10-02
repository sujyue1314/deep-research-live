// 探照灯会话：状态 + 事件总线 + SSE 回放
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export const MODES = {
  quick: {
    maxSteps: 26,
    maxSearches: 8,
    maxPages: 10,
    maxSections: 4,
    timeoutMs: 5 * 60_000,
    diversitySearches: 1, // 收尾前单一域名守卫批准的异源补搜
  },
  deep: {
    maxSteps: 48,
    maxSearches: 16,
    maxPages: 24,
    maxSections: 7,
    timeoutMs: 12 * 60_000,
    diversitySearches: 1,
  },
  // 严格模式：调查员取证 → 质疑者挑战 → 调查员答辩 → 裁决者撰写
  strict: {
    maxSteps: 22,     // 调查员阶段步数
    maxSearches: 9,   // 调查员阶段搜索
    maxPages: 10,     // 调查员阶段阅读
    maxSections: 5,
    timeoutMs: 15 * 60_000,
    // 辩论阶段预算
    rebuttalSteps: 4,      // 调查员答辩步数
    rebuttalSearches: 3,   // 质疑触发的追加搜索
    maxChallenges: 4,      // 质疑者最多提出的挑战
    diversitySearches: 2,  // 单一域名风险触发后的系统异源补搜（可重试一次，自动排除已知域名）
  },
};

export class ResearchSession {
  constructor({ question, mode = "quick", mock = false }) {
    this.id = `rs_${randomUUID().slice(0, 12)}`;
    this.question = String(question || "").slice(0, 400);
    this.mode = MODES[mode] ? mode : "quick";
    this.mock = !!mock;
    this.limits = MODES[this.mode];
    this.createdAt = Date.now();

    this.phase = "idle"; // idle -> running -> writing | done | error | stopped
    this.plan = []; // [{ id, text, status }]
    this.principles = []; // 第一性要素
    this.evidence = []; // [{ id, url, title, quote, note }]
    this.sections = []; // [{ index, heading, markdown, citations }]
    this.conflicts = []; // [{ id, urls, description }]
    this.stats = { steps: 0, searches: 0, pages: 0, providers: {} };
    this.oneLine = null;
    this.qa = []; // 报告完稿后的追问 [{ id, q, a, note }]

    // 内部
    this._knownUrls = new Set(); // 经搜索/读取出现过的原始 URL（引用合法性校验用）
    this._knownCanon = new Set(); // 规范化形式（兼容手动编码/斜杠变体）
    this._pageCache = new Map(); // url -> 正文摘要
    this._knownContext = new Map(); // url -> 上下文文本（搜索摘要或正文摘录，引文核验对照用）
    this._events = []; // 全量事件历史（断线重连回放用）
    this._aborted = false;
    this._bus = new EventEmitter();
    this._bus.setMaxListeners(50);
  }

  /** 序列化：状态 + 全量事件日志（供持久化与跨进程回放） */
  toJSON() {
    return {
      id: this.id,
      question: this.question,
      mode: this.mode,
      mock: this.mock,
      phase: this.phase,
      createdAt: this.createdAt,
      plan: this.plan,
      principles: this.principles,
      evidence: this.evidence,
      sections: this.sections,
      conflicts: this.conflicts,
      stats: this.stats,
      oneLine: this.oneLine,
      qa: this.qa,
      events: this._events,
      closed: this.closed,
      finishedAt: this._finishedAt ?? null, // iter-14
      savedAt: Date.now(),
    };
  }

  /** 反序列化：重建一个可回放/可追问的会话（校验上下文不恢复，仅用于直播后的重放） */
  static fromJSON(data) {
    const s = new ResearchSession({ question: data.question, mode: data.mode, mock: data.mock });
    s.id = data.id || s.id;
    s.phase = data.phase || "done";
    s.createdAt = data.createdAt || s.createdAt;
    s.plan = data.plan || [];
    s.principles = data.principles || [];
    s.evidence = data.evidence || [];
    s.sections = data.sections || [];
    s.conflicts = data.conflicts || [];
    s.stats = data.stats || s.stats;
    s.oneLine = data.oneLine ?? null;
    s.qa = data.qa || [];
    s._events = Array.isArray(data.events) ? data.events : [];
    s.closed = !!data.closed;
    s._finishedAt = data.finishedAt ?? null;
    return s;
  }

  get state() {
    return {
      id: this.id,
      question: this.question,
      mode: this.mode,
      mock: this.mock,
      phase: this.phase,
      createdAt: this.createdAt,
      plan: this.plan,
      principles: this.principles,
      evidence: this.evidence,
      sections: this.sections,
      conflicts: this.conflicts,
      stats: this.stats,
      oneLine: this.oneLine,
      qa: this.qa,
      // iter-14：已完稿会话携带真实用时（秒），回放端据此显示计时；未完稿/旧记录无此字段
      durationSec:
        this._finishedAt != null
          ? Math.max(0, Math.round((this._finishedAt - this.createdAt) / 1000))
          : undefined,
    };
  }

  /** 推送一个事件：本地记录 + 广播给 SSE 订阅者 */
  // 会话关闭后，qa-*（追问）事件仍允许推送：报告完稿后的 Q&A 复用同一条事件总线
  emit(evt) {
    if (this.closed && !(typeof evt?.type === "string" && evt.type.startsWith("qa"))) return;
    this._events.push(evt);
    this._bus.emit("event", evt);
  }

  /** 前端（重新）订阅时回放全部历史 */
  replay(onEvent) {
    for (const e of this._events) onEvent(e);
  }

  subscribe(onEvent) {
    const fn = (e) => onEvent(e);
    this._bus.on("event", fn);
    return () => this._bus.off("event", fn);
  }

  /** URL 规范化：小写 host、去尾斜杠、统一解码/编码，用于匹配百分号编码变体 */
  canonUrl(raw) {
    try {
      const u = new URL(raw);
      let path;
      try {
        path = decodeURIComponent(u.pathname);
      } catch {
        path = u.pathname;
      }
      path = path.replace(/\/+$/, "");
      return `${u.protocol}//${u.host.toLowerCase()}${encodeURI(path)}`;
    } catch {
      return String(raw).trim().toLowerCase();
    }
  }

  isKnown(url) {
    if (!url) return false;
    return this._knownUrls.has(url) || this._knownCanon.has(this.canonUrl(url));
  }

  noteKnown(url) {
    if (!url) return;
    this._knownUrls.add(url);
    this._knownCanon.add(this.canonUrl(url));
  }

  knownContext(url) {
    return this._knownContext.get(url) || null;
  }

  noteContext(url, text) {
    if (!url || !text) return;
    // 保留最长的上下文文本（搜索摘要后续会被完整正文取代）
    const prev = this._knownContext.get(url);
    if (!prev || text.length > prev.length) this._knownContext.set(url, text);
  }

  pageCache(url) {
    return this._pageCache.get(url) || null;
  }

  cachePage(url, extract) {
    if (url && extract) this._pageCache.set(url, extract);
  }

  /** 请求停止当前调查 */
  abort() {
    if (this.phase === "done" || this.phase === "error") return;
    this._aborted = true;
  }

  get aborted() {
    return this._aborted;
  }

  /** 消费停止信号并重置（iter-15：旧代码直接 session.aborted = false ——
      给只读 getter 赋值在 ESM 严格模式必抛 TypeError；超时/手动停止会
      把会话打成 error 而非按已有证据诚实收尾） */
  consumeAbort() {
    const was = this._aborted;
    this._aborted = false;
    return was;
  }

  /** 收尾：固化最终状态 */
  finish(reason = "done") {
    if (this.closed) return;
    this.phase = reason === "error" ? "error" : "done";
    this._finishedAt = Date.now(); // iter-14：回放计时用真实用时，不再显示死钟 00:00
    this.emit({ type: "state", state: this.state });
    this.emit({ type: "done", phase: this.phase, reason });
    this.closed = true;
  }
}
