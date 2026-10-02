// 探照灯 Agent：JSON 协议驱动
// 单智能体模式（quick/deep）：调查 → 写报告，全程带机器强制校验
// 严格模式（strict）：调查员取证 → 质疑者挑战 → 调查员答辩 → 裁决者写报告
import { chatJsonStream } from "../ai/client.js";
import { webSearch, fetchPage } from "./tools.js";
import {
  pageTier,
  extractYear,
  quoteInText,
  distinctHostCount,
  distinctHosts,
  hostOf,
} from "./verify.js";

const STEP_MAX_TOKENS = 6000;
const PAGE_OBS_CHARS = 4000; // 回灌给模型的正文长度上限
const ALLOWED_TOOLS = new Set([
  "update_plan",
  "web_search",
  "open_page",
  "save_evidence",
  "note_conflict",
  "write_section",
  "finish",
]);

/* ---------- 日期与时效性（iter-9） ---------- */

const WEEKDAYS = "日一二三四五六";
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日（周${WEEKDAYS[d.getDay()]}）`;
}

/** 问题涉及时效性：相对时间词、或出现当前年/去年 */
export function isTimeSensitive(text = "") {
  if (/今年|去年|最新|近期|最近|当下|现状|现在|截至目前|以来/.test(text)) return true;
  const cur = new Date().getFullYear();
  for (const m of text.matchAll(/(\d{4})\s*年/g)) {
    if (Number(m[1]) >= cur - 1) return true;
  }
  return false;
}

const CORE_PROMPT = (question, budget = null) => {
  const BUDGET_NOTE = budget?.maxSteps ?? "?";
  return `你是「探照灯」的调查员 Atria，面向公众做深度调查直播。观众在大屏上实时看着你的每一步思考和操作，请保持专业又生动的调查员口吻。

【当前日期】
今天是 ${todayStr()}。你的训练记忆不覆盖最近约一年的事件——凡涉及该时段的事实，一律 web_search 取证，不得凭记忆作答；不确定时明确声明数据截止时点。
${isTimeSensitive(question) ? "【本问题涉及时效】子问题中必须包含一条「最新动态」方向；查最新数据时给 web_search 传 recency: \"year\"。" : "本问题以历史数据为主，搜索时不需要限制时间范围。"}

【研究问题】
${question}

【工作流程】
拆解问题 → 联网搜索 → 阅读网页取证 → 固定证据卡片 → 发现并裁决来源冲突 → 撰写带引用的结论报告。

【输出格式】每一步只输出一个 JSON 对象，结构严格如下：
{
  "thought": "用第一人称、口语化中文向观众解释你这一步的想法、判断和下一步打算（50-150 字）",
  "action": { "tool": "工具名", ...工具参数 }
}
注意：字符串值内部如需引用某词，用中文引号「」（不要用未转义的英文双引号 "，那会破坏 JSON）。

【可用工具】
1. update_plan — 第一步必须调用。先列「第一性要素」，再拆子问题。参数：
   {"principles": ["回答该问题所需的不可再分的事实基础/权威口径，如：比较类问题先明确比较主体与口径；数值类问题先确定官方统计口径与年份"], "subquestions": ["子问题1", "子问题2", ...]（3-5 个）}
2. web_search — 搜索。参数：{"query": "搜索关键词", "recency": "可选：查年度最新动态传 \"year\"、月度内 \"month\"、周内 \"week\"、日内 \"day\"；查历史数据不要传此字段"}
3. open_page — 阅读网页正文。参数：{"url": "https://..."}（url 必须来自搜索结果）
4. save_evidence — 固定证据卡片。参数：{"url", "title", "quote": "必须从原文逐字摘录的关键句（省略可用……）", "note": "这条证据说明了什么"}
5. note_conflict — 标记来源冲突：这是直播的关键时刻，请向观众清楚解释两方说法与你的裁决思路。参数：{"urls": ["urlA", "urlB"], "description": "冲突描述"}
6. write_section — 写报告章节。参数：{"heading": "章节标题", "markdown": "正文，用 [数字] 标注引用（数字对应第 n 个 save_evidence 证据的编号）", "plan": "必填：本节回答调查计划（update_plan 的 subquestions）的第几个子问题（1 起）", "citations": ["url", ...]}
7. finish — 完成。参数：{"one_line": "一句话核心结论"}

【步数预算与写作纪律（重要）】
本次调查共约 ${BUDGET_NOTE} 步。须知：证据不必穷尽，报告必须产出。
- 过半时仍未写任何章节（write_section）就是失败节奏——证据足以支撑结论时立即写，边写边补证。
- 每节正文至少 2 条引用；写满 2-3 节即可 finish，不要把步数花在重复搜索上。

【信息准确性铁律】
- 所有 url 必须来自 web_search / open_page 返回的结果，严禁编造地址；引用编号 [n] 不得超过已固定证据的数量。
- save_evidence 的 quote 必须是来源页面的原文逐字摘录（系统会机器校验，编造的引文会被拒收）。
- 来源分级：官方机构/权威媒体/百科为「权威」；聚合与自媒体为「一般」或「存疑」。关键结论必须优先引用权威来源，「存疑」来源不能单独支撑任何结论。
- 同一结论若有 ≥2 个不同域名的独立来源支撑，才可标为高置信；否则只能中/低置信。
- 数值类结论必须注明单位与统计时点。
- 发现来源矛盾时必须 note_conflict 并说明裁决依据。

【报告结构】
背景速览（含第一性要素的口径声明）→ 核心发现（含冲突裁决）→ 结论与依据（含不确定性说明）。每个章节至少引用 2 条证据。

【行动纪律（重要）】
- 展会直播必须产出：任何问题都要尝试给出基于证据的回答；证据不完美时如实标注缺口并降低置信度，绝不以「问题不够明确」「信息不足」为由拒绝调查或提前 finish。
- 来源不完美是常态：先取证、再分级；权威源不够就用一般源并明确标注，不要因为无法做到完美而停摆。

每步结束后，系统会把工具执行结果以【系统】消息返回给你，继续你的下一步。`;
};

const STRICT_PROMPT_SUFFIX = `
【当前为严格模式】你只负责取证与答辩，不要调用 write_section。证据收集充分（或预算耗尽）后立即调用 finish 结束调查；报告将由裁决者（另一智能体）基于你的证据与辩论撰写。质疑者随后会挑战你的证据，请届时逐条回应。`;

/* ---------- 工具函数 ---------- */

// CJK 意群分词：中文转二元组、拉丁词整体小写
function tokens(s) {
  const out = new Set();
  for (const seg of s.match(/[\u4e00-\u9fa5]+|[a-zA-Z0-9]+/g) || []) {
    if (/[\u4e00-\u9fa5]/.test(seg)) {
      for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
    } else {
      out.add(seg.toLowerCase());
    }
  }
  return out;
}

function overlap(a, b) {
  const sa = tokens(a);
  const sb = tokens(b);
  if (!sa.size || !sb.size) return 0;
  let hit = 0;
  for (const t of sa) if (sb.has(t)) hit++;
  return hit / Math.min(sa.size, sb.size);
}

const PLAN_RANK = { pending: 0, active: 1, done: 2 };

// 启发式：把与当前 query/证据相关性最高的子问题置为 active/done
function touchPlan(session, text, status) {
  if (!session.plan.length) return;
  let best = -1;
  let bestScore = 0.35;
  session.plan.forEach((item, i) => {
    if (PLAN_RANK[item.status] >= PLAN_RANK[status]) return;
    const sc = overlap(item.text, text);
    if (sc > bestScore) {
      bestScore = sc;
      best = i;
    }
  });
  if (best >= 0) {
    session.plan[best].status = status;
    session.emit({ type: "plan", items: session.plan });
  }
}

function relaySection(session, index, heading, markdown, confidence, crossVerified) {
  // 正文随 section 事件完整下发（iter-11）：服务端不再逐帧推 chunk。
  // 原先 setTimeout 队列推 section-chunk，finish() 关闭会话后队列被
  // closed 截断，末节正文停在半句（如「控制在 2500」）；打字机改由前端按 markdownFull 自播。
  session.emit({ type: "section", index, heading, markdown, confidence, crossVerified });
}

function shortUrl(u) {
  try {
    return new URL(u).host + new URL(u).pathname.slice(0, 24);
  } catch {
    return String(u).slice(0, 48);
  }
}

export function evidenceBrief(session) {
  return session.evidence
    .map(
      (e) =>
        `证据 #${e.index} [${e.tierLabel}来源${e.verified ? "·引文已核验" : "·引文未核验"}${e.year ? `·${e.year}` : ""}·域名 ${hostOf(e.url)}]\n标题：${e.title}\nURL：${e.url}\n引文：“${e.quote}”\n说明：${e.note}`,
    )
    .join("\n\n");
}

/**
 * iter-18：模型输出格式诊断（纯函数，供主循环与单测共用）
 * 返回一句话诊断：缺 action / 缺 tool / JSON 解析失败（带位置与片段，并点出
 * 未转义英文双引号这一实测最高频的根因——rs_95967da1 第 2 步 position 85）。
 * 合法输出返回空串。
 */
export function diagnoseActionOutput(content, parsed) {
  if (parsed && typeof parsed === "object") {
    if (!parsed.action || typeof parsed.action !== "object") {
      return `这次输出可解析，但缺少 action 字段（外层只有 ${Object.keys(parsed).join("/") || "空对象"}）。`;
    }
    const keys = Object.keys(parsed.action);
    if (!parsed.action.tool) {
      // 按字段特征给出「该怎么补」的提示（仍是让模型自己重发，不代它执行）
      const infer =
        keys.some((k) => k === "principles" || k === "subquestions")
          ? "看字段是要更新调查计划，请补 \"tool\": \"update_plan\"。"
          : keys.includes("heading") || keys.includes("markdown")
            ? "看字段是要写报告章节，请补 \"tool\": \"write_section\"。"
            : keys.includes("query")
              ? "看字段是要检索，请补 \"tool\": \"web_search\"。"
              : "";
      return `action 缺少 "tool" 字段（当前字段：${keys.join("/") || "空"}）。${infer}`;
    }
    return "";
  }
  // parsed 为空：raw 解析拿原生报错（含位置）
  let err = "无法解析";
  try {
    JSON.parse(String(content ?? ""));
  } catch (e) {
    err = String(e?.message || e).slice(0, 120);
  }
  const m = err.match(/position (\d+)/);
  const pos = m ? Number(m[1]) : null;
  const snippet =
    pos != null && typeof content === "string"
      ? `出错位置附近：…${JSON.stringify(content.slice(Math.max(0, pos - 14), pos + 14))}…。`
      : "";
  return `JSON 解析失败：${err}。${snippet}常见原因：字符串值内出现未转义的英文双引号（例 "社会进步"）——值内引号请写成 \\" 或改用中文引号「」。`;
}

/* ---------- 源多样性守卫 ---------- */

/**
 * 单一域名风险检测（确定性，不依赖模型自报）：
 * 证据 >= 2 条且全部来自同一域名 → 关键结论缺乏独立交叉验证，触发主动异源补搜
 */
function diversityRisk(session) {
  const hosts = distinctHosts(session.evidence.map((e) => e.url));
  if (session.evidence.length >= 2 && hosts.length === 1) {
    return { flagged: true, host: hosts[0], count: session.evidence.length };
  }
  return { flagged: false, host: null, count: session.evidence.length };
}

/**
 * 推送一条「交叉验证守卫」质疑卡：与模型提出的质疑同事件协议、独立视觉变体
 */
function emitDiversityChallenge(session, risk, query, id) {
  session.emit({
    type: "challenge",
    id,
    kind: "diversity",
    text: `单一域名风险：当前 ${risk.count} 条证据全部来自 ${risk.host}，关键结论缺乏独立交叉验证。`,
    host: risk.host,
    count: risk.count,
    query: query || null,
    hasSearch: !!query,
  });
}

/* ---------- Action 执行器（含机器强制校验） ---------- */

async function executeAction(session, action, opts = {}) {
  const tool = action?.tool;
  const limits = session.limits;
  const budget = opts.budget || limits;

  switch (tool) {
    case "update_plan": {
      const principles = Array.isArray(action.principles)
        ? action.principles.map((s) => String(s || "").trim()).filter(Boolean)
        : [];
      const subs = Array.isArray(action.subquestions)
        ? action.subquestions.map((s) => String(s || "").trim()).filter(Boolean)
        : [];
      if (!principles.length) {
        return {
          ok: false,
          msg: "principles 不能为空：请先列出回答该问题的第一性要素（不可再分的事实基础/权威口径）",
        };
      }
      if (!subs.length) return { ok: false, msg: "subquestions 不能为空" };
      session.plan = subs.slice(0, 8).map((text, i) => ({
        id: `p${i}`,
        text,
        status: "pending",
      }));
      session.principles = principles.slice(0, 8);
      session.emit({ type: "principles", items: principles.slice(0, 8) });
      session.emit({ type: "plan", items: session.plan });
      return {
        ok: true,
        obs: `【系统】调查计划已更新：${principles.length} 条第一性要素 + ${session.plan.length} 个子问题。`,
      };
    }

    case "web_search": {
      if (session.stats.searches >= budget.maxSearches) {
        // 守卫额外批准的异源补搜预算（仅单一域名风险触发时存在）
        if ((session._diversityGrant || 0) > 0) {
          session._diversityGrant -= 1;
          session.emit({ type: "notice", text: "系统守卫已额外批准一次异源检索" });
        } else {
          return { ok: false, msg: `搜索预算（${budget.maxSearches} 次）已用尽，请改用已有证据写报告或 finish。` };
        }
      }
      const query = String(action.query || "").trim();
      if (!query) return { ok: false, msg: "query 不能为空" };
      // 时效限定（iter-9）：模型按提示词传 recency，服务端校验取值
      const RECENCY = ["year", "month", "week", "day", "hour"];
      const recency = RECENCY.includes(action.recency) ? action.recency : undefined;
      session.stats.searches += 1;
      session.emit({ type: "search", query, n: session.stats.searches, recency });
      touchPlan(session, query, "active");
      const { results, provider } = await webSearch(query, 5, recency ? { timeRange: recency } : {});
      results.forEach((r) => {
        session.noteKnown(r.url);
        session.noteContext(r.url, `${r.title} ${r.snippet}`);
      });
      session.stats.providers[provider] = (session.stats.providers[provider] || 0) + 1;
      session.emit({ type: "search-results", query, results, provider });
      // 通道健康守卫（iter-10）：连续全空检索 → 广播醒目通告
      // （此前发生过：进程无 TAVILY 密钥 → 8 次全空 → 烧光步数才知道）
      if (results.length === 0) {
        session._emptyStreak = (session._emptyStreak || 0) + 1;
        if (session._emptyStreak === 3 || session._emptyStreak === 6) {
          session.emit({
            type: "notice",
            text: `【通道异常】检索已连续 ${session._emptyStreak} 次返回空结果（来源：${provider}）——疑似搜索密钥缺失或网络异常，请查看服务器启动日志的通道武装状态。`,
          });
        }
      } else {
        session._emptyStreak = 0;
      }
      const lines = results.map(
        (r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || "（无摘要）"}`,
      );
      const obs = results.length
        ? `【系统】搜索「${query}」返回 ${results.length} 条结果（来源：${provider}）：\n${lines.join("\n")}`
        : `【系统】搜索「${query}」没有返回结果（来源：${provider}），换个关键词试试。`;
      return { ok: true, obs };
    }

    case "open_page": {
      if (session.stats.pages >= budget.maxPages) {
        return { ok: false, msg: `阅读预算（${budget.maxPages} 次）已用尽，请基于已读内容写报告或 finish。` };
      }
      const url = String(action.url || "").trim();
      if (!url) return { ok: false, msg: "url 不能为空" };
      if (!session.isKnown(url)) {
        return { ok: false, msg: `该 URL 未曾出现在搜索/读取结果中：${shortUrl(url)}。请只使用已知的 url。` };
      }
      session.stats.pages += 1;
      session.emit({ type: "page-open", url, n: session.stats.pages });
      touchPlan(session, url, "active");
      const cached = session.pageCache(url);
      let extract;
      try {
        extract = cached || (await fetchPage(url, 8000));
        if (extract.text.length > PAGE_OBS_CHARS) {
          extract = { ...extract, text: extract.text.slice(0, PAGE_OBS_CHARS) };
        }
      } catch (e) {
        const msg = String(e?.message || e);
        session.emit({ type: "page-fail", url, message: msg });
        return { ok: true, obs: `【系统】页面读取失败：${msg}。换一个来源继续。` };
      }
      session.cachePage(url, extract);
      session.noteContext(url, extract.text);
      session.emit({
        type: "page-read",
        url,
        title: extract.title,
        chars: extract.text.length,
        snippet: extract.text.slice(0, 180).replace(/\n+/g, " "),
      });
      return {
        ok: true,
        obs: `【系统】《${extract.title}》正文（${shortUrl(url)}，${extract.text.length} 字）：\n${extract.text}`,
      };
    }

    case "save_evidence": {
      const url = String(action.url || "").trim();
      const title = String(action.title || "").trim() || shortUrl(url);
      const quote = String(action.quote || "").trim().slice(0, 300);
      const note = String(action.note || "").trim().slice(0, 300);
      if (!url) return { ok: false, msg: "url 不能为空" };
      if (!quote) return { ok: false, msg: "quote 不能为空：请从原文摘录关键句" };
      if (!session.isKnown(url)) {
        return { ok: false, msg: `证据 URL 未经搜索/读取验证：${shortUrl(url)}。请先用 web_search 或 open_page 核实。` };
      }
      // 引文核验：quote 必须出现在来源上下文（正文或搜索摘要）中
      const context = session.knownContext(url) || session.pageCache(url)?.text || "";
      let verified = false;
      if (context) {
        if (!quoteInText(quote, context)) {
          return {
            ok: false,
            msg: `引文未能在来源正文中找到（机器校验）。请打开页面后从原文逐字摘录，或使用搜索摘要中出现过的原句。`,
          };
        }
        verified = true;
      }
      const tier = pageTier(url, title);
      const year = extractYear(title, quote, note);
      const index = session.evidence.length + 1;
      session.evidence.push({
        id: `e${index}`,
        index,
        url,
        title,
        quote,
        note,
        tier: tier.tier,
        tierLabel: tier.label,
        verified,
        year,
      });
      touchPlan(session, `${quote} ${note}`, "done");
      session.emit({
        type: "evidence",
        id: `e${index}`,
        index,
        url,
        title,
        quote,
        note,
        tier: tier.tier,
        tierLabel: tier.label,
        verified,
        year,
      });
      return {
        ok: true,
        obs: `【系统】证据 #${index} 已固定（${tier.label}来源${verified ? "·引文已核验" : "·未核验"}）。当前共 ${session.evidence.length} 条证据。`,
      };
    }

    case "note_conflict": {
      const urls = Array.isArray(action.urls) ? action.urls.map((u) => String(u)).filter(Boolean) : [];
      const description = String(action.description || "").slice(0, 500);
      const unknown = urls.filter((u) => !session.isKnown(u));
      if (unknown.length) {
        return { ok: false, msg: `冲突中的 URL 未经验证：${unknown.map(shortUrl).join("、")}` };
      }
      session.conflicts.push({ id: `c${session.conflicts.length + 1}`, urls, description });
      session.emit({ type: "conflict", id: session.conflicts.length, urls, description });
      return {
        ok: true,
        obs: `【系统】来源冲突已记录（第 ${session.conflicts.length} 组）。继续查证或说明你的裁决依据。`,
      };
    }

    case "write_section": {
      if (opts.rejectWriteSection) {
        return {
          ok: false,
          msg: "严格模式下报告由裁决者撰写，调查员只负责取证。请继续取证或 finish。",
        };
      }
      if (session.sections.length >= limits.maxSections) {
        return { ok: false, msg: `章节预算（${limits.maxSections} 个）已用尽，请 finish 收尾。` };
      }
      const heading = String(action.heading || "").trim().slice(0, 60) || "未命名章节";
      const markdown = String(action.markdown || "").slice(0, 3000);
      if (markdown.length < 30) {
        return { ok: false, msg: "markdown 正文过短，请写出实质内容（至少引用 2 条证据）" };
      }
      // 引用编号校验：[n] 不得超过证据数量
      const cited = [...markdown.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
      const knownRefs = new Set(session.evidence.map((e) => e.index));
      const invalid = cited.filter((n) => !knownRefs.has(n));
      if (invalid.length) {
        return {
          ok: false,
          msg: `引用编号 ${invalid.map((n) => `[${n}]`).join("、")} 无对应证据（当前共 ${session.evidence.length} 条）。请修正引用或先 save_evidence。`,
        };
      }
      const citations = Array.isArray(action.citations)
        ? action.citations.map((u) => String(u)).filter(Boolean)
        : [];
      // 独立来源交叉验证
      const hosts = distinctHostCount(
        cited.map((n) => session.evidence.find((e) => e.index === n)?.url).filter(Boolean),
      );
      const crossVerified = hosts >= 2;
      const index = session.sections.length + 1;
      session.sections.push({ index, heading, markdown, citations, crossVerified });
      relaySection(session, index, heading, markdown, crossVerified ? "高" : "中", crossVerified);
      // iter-15：章节落地推进计划项 —— 优先采信 write_section 里声明的 plan 编号
      // （机器可校验：编号有效即标完成）。
      // 未声明时只推进到「进行中」：文本词面匹配跨会话验证不可靠（假阳/假阴都有），
      // 机器不知道这节回答了哪个子问题，就不假装知道（抽屉如实显示三态计数）
      {
        const idx = Number(action.plan) - 1;
        if (Number.isInteger(idx) && session.plan[idx] && session.plan[idx].status !== "done") {
          session.plan[idx].status = "done";
          session.emit({ type: "plan", items: session.plan });
        } else {
          touchPlan(session, heading, "active");
        }
      }
      return {
        ok: true,
        obs: `【系统】第 ${index} 节「${heading}」已写入报告（${crossVerified ? "≥2 个独立来源，交叉验证通过" : `仅来自单一域名（${hosts}），置信度只能为中`}）。${
          session.sections.length >= limits.maxSections
            ? "章节预算已用尽，请立即 finish。"
            : "继续写下一节，或 finish 收尾。"
        }`,
      };
    }

    case "finish": {
      // 单一域名守卫（quick/deep）：证据全部同域名时拦截一次，给异源补证机会
      if (!opts.strictSuffix && !session._diversityGuardUsed && session.evidence.length >= 2) {
        const hosts = distinctHosts(session.evidence.map((e) => e.url));
        if (hosts.length === 1) {
          session._diversityGuardUsed = true;
          const grant = limits.diversitySearches || 1;
          session._diversityGrant = (session._diversityGrant || 0) + grant;
          emitDiversityChallenge(session, { host: hosts[0], count: session.evidence.length }, null, 1);
          return {
            ok: false,
            msg: `系统守卫：所有 ${session.evidence.length} 条证据均来自单一域名 ${hosts[0]}。这是收尾前的补证机会（系统已额外批准 ${grant} 次搜索）：请用一条面向该域名之外权威来源的关键词做一次 web_search，并固定至少一条异源证据后再写报告；若确实找不到异源来源，可再次 finish 放行，但相应结论置信度只能为中。`,
          };
        }
      }
      // 守卫后仍单域名：如实标注，置信度上限由 write_section 机器规则压到中
      if (session._diversityGuardUsed && session.evidence.length >= 2) {
        const hosts = distinctHosts(session.evidence.map((e) => e.url));
        if (hosts.length === 1) {
          session.emit({ type: "notice", text: "单一域名交叉验证未达成：报告相应结论置信度上限为中" });
        }
      }
      // 零证据拦截：防止「拒绝调查」式收尾，给模型两次改正机会后放行
      if (!session.evidence.length && (session._finishAttempts || 0) < 2) {
        session._finishAttempts = (session._finishAttempts || 0) + 1;
        return {
          ok: false,
          msg: "不能在零证据状态下 finish：展会直播必须产出。请至少固定 1 条证据（save_evidence）再收尾；若来源确实不理想，保存能拿到的最佳来源并在结论中如实低置信度说明。",
        };
      }
      const oneLine = String(action.one_line || "").trim().slice(0, 200);
      if (oneLine) {
        session.oneLine = oneLine;
        session.emit({ type: "one-line", text: oneLine });
      }
      return { ok: true, obs: null, terminal: true };
    }

    default:
      return { ok: false, msg: `未知工具「${tool}」。可用工具：${[...ALLOWED_TOOLS].join("、")}` };
  }
}

/* ---------- 通用调查员循环 ---------- */

async function investigatorLoop(session, opts = {}) {
  const budget = opts.budget || session.limits;
  const stopSteps = opts.stopSteps ?? session.limits.maxSteps;
  // 日期锚点（iter-9）：让观众看到「今天」与记忆边界
  if (opts.anchor !== false) {
    session.emit({
      type: "notice",
      text: `日期锚点：今天是 ${todayStr()}；训练记忆之外的近期事实将一律联网取证。`,
    });
  }
  const messages = opts.messages || [
    {
      role: "system",
      content: CORE_PROMPT(session.question, budget) + (opts.strictSuffix ? STRICT_PROMPT_SUFFIX : ""),
    },
    {
      role: "user",
      content:
        opts.firstMessage ||
        `今天是 ${todayStr()}。开始调查：请先输出第一步，列出第一性要素并拆解子问题（update_plan），时效敏感问题记得安排「最新动态」方向。`,
    },
  ];
  let invalidStreak = 0;
  let forcedFinishSteps = 0;

  while (session.stats.steps < stopSteps) {
    if (session.aborted) {
      return "aborted"; // 信号由调度层 consumeAbort 消费后诚实收尾
    }

    session.stats.steps += 1;
    const stepNo = session.stats.steps;
    session.emit({ type: "step", n: stepNo, voice: "investigator" });

    // 写作节奏守卫（iter-12）：步数过 60% 仍无章节，插入系统催稿
    // （此前 quick 模式 26 步全部搜/读、一节没写就预算耗尽）
    if (session.sections.length === 0 && stepNo === Math.ceil(stopSteps * 0.6)) {
      session.emit({ type: "notice", text: `步数已过六成、尚无报告章节——系统催稿：转向 write_section` });
      messages.push({
        role: "user",
        content:
          "【系统催稿】步数预算已用约六成，但还没有 write_section 产出。现在请依据已固定的证据立即撰写第一节报告（write_section），后续按剩余步数决定是否补写与 finish。不要再搜索。",
      });
    }

    // 流式调用：原始 JSON 块直接转发，前端实时渲染 thought
    let result;
    try {
      result = await chatJsonStream(
        {
          messages,
          temperature: 0.7,
          maxTokens: STEP_MAX_TOKENS,
          json: true,
        },
        (delta, isReasoning) => {
          if (!isReasoning && delta) {
            session.emit({ type: "text-chunk", chunk: delta });
          }
        },
      );
    } catch (e) {
      session.emit({ type: "error", message: `模型调用失败：${String(e?.message || e).slice(0, 200)}` });
      session.finish("error");
      return "error";
    }
    session.emit({ type: "text-done" });

    const parsed = result?.parsed;
    const action = parsed?.action;
    messages.push({ role: "assistant", content: result?.content || "{}" });

    if (!action || typeof action !== "object" || !action.tool) {
      invalidStreak += 1;
      const empty = !result?.content;
      // iter-18：精确反馈——旧提示只有「输出格式不正确」五个字，
      // model 只能瞎猜（rs_95967da1 里它把未转义英文引号误诊成「中文引号」，白烧两步）。
      // 现在把缺什么、错在哪、怎么改写清楚，让模型一步改对。
      messages.push({
        role: "user",
        content: empty
          ? "【系统】上一步没有输出任何内容（推理耗尽了输出预算）。请直接输出 JSON：{\"thought\": \"向观众解释这一步（50-150字）\", \"action\": {\"tool\": \"...\", ...参数}}，不要做冗长推理。"
          : `【系统】${diagnoseActionOutput(result.content, parsed)}` +
            `必须输出 JSON：{\"thought\": \"...\", \"action\": {\"tool\": \"...\", ...}}。可用工具：${[...ALLOWED_TOOLS].join("、")}。`,
      });
      if (invalidStreak >= 3) {
        session.emit({ type: "notice", text: "连续格式异常，直接收尾" });
        break;
      }
      continue;
    }

    const r = await executeAction(session, action, opts);
    if (r.terminal) return "finished";
    if (r.ok) {
      invalidStreak = 0;
      if (r.obs) messages.push({ role: "user", content: r.obs });
    } else {
      messages.push({ role: "user", content: `【系统】上一步执行失败：${r.msg}` });
    }

    // 预算耗尽：最多再给 3 步收尾（任一预算用尽即触发——原先 && 会因差一页而漏网）
    const budgetExhausted =
      session.stats.searches >= budget.maxSearches ||
      session.stats.pages >= budget.maxPages;
    if (budgetExhausted) {
      forcedFinishSteps += 1;
      if (forcedFinishSteps === 1) {
        session.emit({ type: "notice", text: "取证预算用尽，进入收尾" });
        messages.push({
          role: "user",
          content: opts.rejectWriteSection
            ? "【系统】取证预算已尽。请立即调用 finish 结束调查，报告由裁决者撰写。"
            : "【系统】工具预算已用尽。请立即 write_section 概述或 finish，不要再调用搜索/阅读。",
        });
      }
      if (forcedFinishSteps > 3) break;
    }
  }
  return "budget";
}

/* ---------- 质疑者阶段 ---------- */

// 导出供手术式测试：直接以预置证据状态调用质疑者，验证单一域名守卫开火链路
export async function runSkeptic(session) {
  const limits = session.limits;
  session.stats.steps += 1;
  session.emit({ type: "step", n: session.stats.steps, voice: "skeptic" });

  // 机器检测：证据是否集中于单一域名（确定性判定，不依赖模型自报）
  const risk = diversityRisk(session);
  const conflictsBrief = session.conflicts.length
    ? session.conflicts.map((c, i) => `冲突${i + 1}：${c.description}`).join("\n")
    : "（未标记冲突）";
  const user = `你是「探照灯」的质疑者。调查员刚完成取证，现在由你向证据开炮，观众在大屏上看你的审查过程。

【当前日期】今天是 ${todayStr()}；对「最新动态」类结论的时效性要格外苛刻。

【研究问题】${session.question}

【已固定证据】
${evidenceBrief(session)}

【冲突记录】
${conflictsBrief}

请审查证据质量，从这些角度逐条挑战最脆弱的环节：
- 来源是否权威？是否依赖存疑/单一来源？
- 数据口径与统计时点是否明确、是否过时？
- 证据链是否足以支撑结论？有无未查的反方证据？
- 引用与结论之间是否过度推断？

输出 JSON：
{
  "thought": "向观众说明你的总体审查判断（50-150 字）",
  "challenges": [
    {"text": "具体质疑内容（点明针对的证据编号或环节）", "search": "可选：为查证该质疑需要追加的搜索关键词"}
  ]${
    risk.flagged
      ? `,\n  "diversity_query": "异源检索关键词：一条面向「${risk.host}」之外其他权威来源的检索词，直接面向研究问题本身，禁用 site: 语法"`
      : ""
  }
}
challenges 1-${limits.maxChallenges} 条，只挑最致命的。${
      risk.flagged
        ? `\n\n【系统单一域名风险】当前 ${risk.count} 条证据全部来自同一域名「${risk.host}」，关键结论缺乏独立交叉验证。diversity_query 为本次必填项。`
        : ""
    }`;

  let result;
  try {
    result = await chatJsonStream(
      {
        messages: [
          {
            role: "system",
            content:
              "你是严格的质量审查员，输出必须是 JSON：{\"thought\": \"...\", \"challenges\": [{\"text\": \"...\", \"search\": \"可选关键词\"}]}。挑战要具体、可执行。",
          },
          { role: "user", content: user },
        ],
        temperature: 0.6,
        maxTokens: 2500,
        json: true,
      },
      (delta, isReasoning) => {
        if (!isReasoning && delta) session.emit({ type: "text-chunk", chunk: delta });
      },
    );
  } catch (e) {
    session.emit({ type: "error", message: `质疑者调用失败：${String(e?.message || e).slice(0, 160)}` });
    return null;
  }
  session.emit({ type: "text-done" });

  const challenges = Array.isArray(result?.parsed?.challenges)
    ? result.parsed.challenges
        .map((c) => ({
          text: String(c?.text || "").slice(0, 300),
          search: c?.search ? String(c.search).slice(0, 120) : null,
        }))
        .filter((c) => c.text)
    : [];
  const capped = challenges.slice(0, limits.maxChallenges);
  capped.forEach((c, i) => {
    session.emit({ type: "challenge", id: i + 1, text: c.text, hasSearch: !!c.search });
  });

  // ===== 交叉验证守卫：单一域名风险的主动异源补搜 =====
  const diversityQuery = risk.flagged
    ? String(result?.parsed?.diversity_query || "").trim().slice(0, 120)
    : null;
  const diversity = {
    ...risk,
    query: diversityQuery,
    tried: false,
    succeeded: false,
    newHosts: [],
    attempts: 0,
  };
  if (risk.flagged) {
    emitDiversityChallenge(session, risk, diversityQuery, capped.length + 1);
    if (diversityQuery) {
      const knownHosts = new Set(distinctHosts(session.evidence.map((e) => e.url)));
      diversity.tried = true;
      while (diversity.attempts < (limits.diversitySearches || 0)) {
        diversity.attempts += 1;
        // 第二次起自动排除已知域名，逼迫异源结果（Tavily exclude_domains）
        const opts = diversity.attempts > 1 ? { excludeDomains: [...knownHosts] } : {};
        session.stats.searches += 1;
        session.emit({
          type: "search",
          query: diversityQuery,
          n: session.stats.searches,
          voice: "skeptic",
        });
        const { results, provider } = await webSearch(diversityQuery, 5, opts);
        results.forEach((r) => {
          session.noteKnown(r.url);
          session.noteContext(r.url, `${r.title} ${r.snippet}`);
        });
        session.emit({ type: "search-results", query: diversityQuery, results, provider, voice: "skeptic" });
        const freshHosts = [
          ...new Set(results.map((r) => hostOf(r.url)).filter((h) => h && !knownHosts.has(h))),
        ];
        if (freshHosts.length) {
          diversity.succeeded = true;
          diversity.newHosts = freshHosts;
          session.emit({
            type: "notice",
            text: `异源补搜成功：发现 ${freshHosts.length} 个新域名来源（${freshHosts.join("、")}），等待调查员固定交叉证据`,
          });
          break;
        }
        if (diversity.attempts < (limits.diversitySearches || 0)) {
          session.emit({
            type: "notice",
            text: `异源补搜第 ${diversity.attempts} 次结果仍限于已知域名，已自动排除 ${risk.host} 重试`,
          });
        }
      }
      if (!diversity.succeeded) {
        session.emit({
          type: "notice",
          text: `异源补搜未能在 ${risk.host} 之外找到相关来源：交叉验证条件未达成，报告置信度上限将为中`,
        });
      }
    } else {
      session.emit({
        type: "notice",
        text: "质疑者未给出异源检索词：按单一来源处理，置信度上限为中",
      });
    }
  }

  // 带 search 的挑战：服务端直接执行追加搜索（预算：rebuttalSearches）
  let searchBudget = limits.rebuttalSearches || 0;
  const rebuttalResults = [];
  for (const c of capped) {
    if (!c.search || searchBudget <= 0) continue;
    searchBudget -= 1;
    session.stats.searches += 1;
    session.emit({ type: "search", query: c.search, n: session.stats.searches, voice: "skeptic" });
    const { results, provider } = await webSearch(c.search, 5);
    results.forEach((r) => {
      session.noteKnown(r.url);
      session.noteContext(r.url, `${r.title} ${r.snippet}`);
    });
    session.emit({ type: "search-results", query: c.search, results, provider, voice: "skeptic" });
    rebuttalResults.push({ challenge: c.text, query: c.search, results });
  }

  // 答辩挑战清单：把守卫质疑一并交给调查员回应
  const allChallenges = risk.flagged
    ? [
        ...capped,
        {
          text: `单一域名风险：当前 ${risk.count} 条证据全部来自 ${risk.host}，请从异源补搜结果中固定至少一条交叉证据`,
          search: diversityQuery,
          isDiversity: true,
        },
      ]
    : capped;
  return { challenges: allChallenges, rebuttalResults, diversity };
}

/* ---------- 裁决者阶段 ---------- */

async function runAdjudicator(session, diversity = null) {
  const limits = session.limits;
  session.stats.steps += 1;
  session.emit({ type: "step", n: session.stats.steps, voice: "adjudicator" });

  const conflictsBrief = session.conflicts.length
    ? session.conflicts.map((c, i) => `冲突${i + 1}：${c.description}（涉及：${c.urls.map(hostOf).join("、")}）`).join("\n")
    : "（无标记冲突）";

  // 交叉验证状态：当前域名分布 + 系统异源补搜结果（供裁决者判定，但最终以机器复核为准）
  const hostsAll = distinctHosts(session.evidence.map((e) => e.url));
  const crossBrief =
    `${session.evidence.length} 条证据覆盖 ${hostsAll.length} 个域名：${hostsAll.join("、")}。` +
    (diversity?.flagged
      ? diversity.succeeded
        ? `系统已异源补搜（检索词「${diversity.query}」），新域名来源已入池，请优先引用异源证据完成跨域名交叉验证。`
        : `系统异源补搜${diversity.tried ? "未找到可用异源来源" : "未能执行（质疑者未给出检索词）"}：不得在报告中宣称未达成的交叉验证，置信度如实判定。`
      : "");

  const user = `你是「探照灯」的裁决者。调查员与质疑者已完成取证与辩论，现在由你裁决争议并撰写最终报告。

【当前日期】今天是 ${todayStr()}；报告须注明数据时点，涉及「最新」的结论须有近期来源支撑。

【研究问题】${session.question}

【证据清单】
${evidenceBrief(session)}

【冲突记录】
${conflictsBrief}

【来源域名分布】${crossBrief}

【裁决规则】
- 置信度「高」：≥2 个不同域名的权威来源一致支撑。
- 置信度「中」：单一权威来源，或多个一般来源一致。
- 置信度「低」：冲突未决、仅存疑来源、或证据不足。
- 引用编号 [n] 必须对应证据清单中的编号，不得超过 ${session.evidence.length}。
- 每个 section 至少引用 1 条证据；证据为零时不要写 section，直接在 one_line 中说明证据缺口并收尾，不得编造无引用的报告。
- 报告必须包含：口径与前提声明、核心发现（含冲突裁决）、结论与不确定性。

输出 JSON：
{
  "thought": "向观众说明你的裁决总判断（50-150 字）",
  "verdicts": [{"text": "对每组未决冲突/核心争议的裁决与依据"}],
  "sections": [{"heading": "章节标题", "markdown": "正文，[n] 引用证据", "confidence": "高|中|低"}],
  "one_line": "一句话核心结论"
}
sections 不超过 ${limits.maxSections} 个。`;

  let result;
  try {
    result = await chatJsonStream(
      {
        messages: [
          {
            role: "system",
            content:
              "你是严谨的裁决编辑，输出必须是 JSON：{\"thought\": \"...\", \"verdicts\": [{\"text\": \"...\"}], \"sections\": [{\"heading\": \"...\", \"markdown\": \"...\", \"confidence\": \"高|中|低\", \"plan\": 本节回答调查计划第几个子问题（1 起）}], \"one_line\": \"...\"}。所有引用必须对应证据清单编号。",
          },
          { role: "user", content: user },
        ],
        temperature: 0.5,
        maxTokens: 8000,
        json: true,
      },
      (delta, isReasoning) => {
        if (!isReasoning && delta) session.emit({ type: "text-chunk", chunk: delta });
      },
    );
  } catch (e) {
    session.emit({ type: "error", message: `裁决者调用失败：${String(e?.message || e).slice(0, 160)}` });
    return false;
  }
  session.emit({ type: "text-done" });

  const parsed = result?.parsed;
  if (!parsed) return false;

  const verdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
  verdicts.forEach((v, i) => {
    session.emit({ type: "verdict", id: i + 1, text: String(v?.text || "").slice(0, 500) });
  });

  const knownRefs = new Set(session.evidence.map((e) => e.index));
  const sections = Array.isArray(parsed.sections) ? parsed.sections.slice(0, limits.maxSections) : [];
  let written = 0;
  for (const s of sections) {
    const heading = String(s?.heading || "").trim().slice(0, 60) || `第 ${written + 1} 节`;
    const markdown = String(s?.markdown || "");
    if (markdown.length < 30) continue;
    // 引用编号校验：无效引用的整节丢弃并告警
    const cited = [...markdown.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    if (!cited.length) {
      session.emit({
        type: "notice",
        text: `「${heading}」未引用任何证据，已丢弃（零引用章节不得入稿）`,
      });
      continue;
    }
    const invalid = cited.filter((n) => !knownRefs.has(n));
    if (invalid.length) {
      session.emit({
        type: "notice",
        text: `裁决者提交的「${heading}」含无效引用 ${invalid.map((n) => `[${n}]`).join("、")}，该节已丢弃`,
      });
      continue;
    }
    const hosts = distinctHostCount(
      cited.map((n) => session.evidence.find((e) => e.index === n)?.url).filter(Boolean),
    );
    const crossVerified = hosts >= 2;
    // 机器复核：声称高置信但缺乏独立来源 → 降级
    let confidence = ["高", "中", "低"].includes(s.confidence) ? s.confidence : "中";
    if (confidence === "高" && !crossVerified) {
      confidence = "中";
      session.emit({
        type: "notice",
        text: `「${heading}」声称高置信但仅有单一来源域名支撑，已降级为中`,
      });
    }
    written += 1;
    const index = session.sections.length + 1;
    session.sections.push({ index, heading, markdown, citations: [], crossVerified });
    relaySection(session, index, heading, markdown, confidence, crossVerified);
    // iter-15：裁决者章节同样推进计划项（声明编号优先，词面匹配兜底）
    {
      const idx = Number(s?.plan) - 1;
      if (Number.isInteger(idx) && session.plan[idx] && session.plan[idx].status !== "done") {
        session.plan[idx].status = "done";
        session.emit({ type: "plan", items: session.plan });
      } else {
        touchPlan(session, heading, "done");
      }
    }
  }

  const oneLine = String(parsed.one_line || "").trim().slice(0, 200);
  if (oneLine) {
    session.oneLine = oneLine;
    session.emit({ type: "one-line", text: oneLine });
  }
  return written > 0 || !!oneLine;
}

/* ---------- 编排 ---------- */

async function finalize(session) {
  if (!session.oneLine) {
    const fallback = session.evidence.length
      ? session.sections.length
        ? `调查完成：收集 ${session.evidence.length} 条证据，形成 ${session.sections.length} 节报告。`
        : `调查因步数预算耗尽提前结束：固定了 ${session.evidence.length} 条证据，但未能形成报告章节（可回放查看已固定证据）。`
      : "调查因预算/中断提前结束，未能形成完整报告。";
    session.oneLine = fallback;
    session.emit({ type: "one-line", text: fallback });
  }
  session.emit({ type: "stats", stats: session.stats });
  session.finish("done");
}

export async function runResearch(session) {
  const limits = session.limits;
  session.phase = "running";
  session.emit({ type: "state", state: session.state });

  const watchdog = setTimeout(() => {
    if (session.phase !== "done" && session.phase !== "error") {
      session.emit({ type: "notice", text: "调查时间到，正在收尾……" });
      session.abort();
    }
  }, limits.timeoutMs);

  try {
    if (session.mode === "strict") {
      // 严格模式：调查 → 质疑 → 答辩 → 裁决
      let r = await investigatorLoop(session, {
        budget: limits,
        stopSteps: limits.maxSteps,
        rejectWriteSection: true,
        strictSuffix: true,
      });
      if (r === "error") return;
      if (session.aborted) {
        session.consumeAbort();
        return finalize(session);
      }

      const skeptic = await runSkeptic(session);
      if (session.aborted) {
        session.consumeAbort();
        return finalize(session);
      }

      if (skeptic && skeptic.challenges.length) {
        // 答辩：把质疑、证据清单与查证结果回灌调查员，可继续取证（不越权写报告）
        const prime = [
          "【系统】质疑者提出以下挑战，请逐条回应（可继续 save_evidence 补证，但不要 write_section）：",
          ...skeptic.challenges.map((c, i) => `${i + 1}. ${c.text}`),
          // 交叉验证指令：系统守卫发现的单一域名风险 + 补搜结果
          ...(skeptic.diversity?.flagged
            ? [
                `【系统交叉验证指令】当前证据集中于单一域名 ${skeptic.diversity.host}。` +
                  (skeptic.diversity.succeeded
                    ? `系统已异源补搜「${skeptic.diversity.query}」，结果中出现新域名来源：${skeptic.diversity.newHosts.join("、")}。请从异源结果中 save_evidence 至少一条证据，使关键结论达到跨域名交叉验证标准。`
                    : `异源补搜${skeptic.diversity.tried ? "已执行但未找到可用异源来源" : "未能执行（质疑者未给出检索词）"}。请如实维持单一来源口径，报告置信度按中处理，不要伪造交叉验证。`),
              ]
            : []),
          "【系统】当前证据清单供你回应时参考：",
          evidenceBrief(session),
          ...(skeptic.rebuttalResults.length
            ? [
                "【系统】质疑者已追加搜索以下关键词，结果已纳入已知来源池，可直接引用：",
                ...skeptic.rebuttalResults.map((r) => `- 「${r.query}」：${r.results.map((x) => x.title).join("；")}`),
              ]
            : []),
        ].join("\n");
        r = await investigatorLoop(session, {
          budget: {
            ...limits,
            // 答辩预算 = 质疑查证 + 系统异源补搜额度（补搜预算不挤占质疑者的查证搜索）
            maxSearches: limits.maxSearches + (limits.rebuttalSearches || 0) + (limits.diversitySearches || 0),
            maxPages: limits.maxPages + 2,
          },
          stopSteps: limits.maxSteps + (limits.rebuttalSteps || 0),
          rejectWriteSection: true,
          strictSuffix: true,
          firstMessage: prime,
          messages: null,
        });
        if (r === "error") return;
      }

      if (session.aborted) {
        session.consumeAbort();
        return finalize(session);
      }
      await runAdjudicator(session, skeptic?.diversity || null);
      await finalize(session);
    } else {
      // 单智能体模式（quick / deep）
      await investigatorLoop(session, { budget: limits });
      await finalize(session);
    }
  } finally {
    clearTimeout(watchdog);
  }
}
