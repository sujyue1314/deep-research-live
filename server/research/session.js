// 调查局会话：状态 + 事件总线 + SSE 回放
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
    };
  }

  /** 推送一个事件：本地记录 + 广播给 SSE 订阅者 */
  emit(evt) {
    if (this.closed) return;
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

  /** 收尾：固化最终状态 */
  finish(reason = "done") {
    if (this.closed) return;
    this.phase = reason === "error" ? "error" : "done";
    this.emit({ type: "state", state: this.state });
    this.emit({ type: "done", phase: this.phase, reason });
    this.closed = true;
  }
}
