// Atria API 客户端：chat / JSON 结构化输出 / SSE 流式
// 全部走 OpenAI 兼容的 /chat/completions 端点
import { BASE_URL, MODEL, API_KEY } from "../config.js";

function headers() {
  if (!API_KEY) throw new Error("尚未找到 ATRIA_API_KEY（见 server/config.js）");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  };
}

/**
 * 普通对话（非流式）
 * @param {{system?:string, messages?:Array, user?:string, json?:boolean, temperature?:number, maxTokens?:number}} opts
 */
export async function chat(opts = {}) {
  const messages = opts.messages
    ? [...opts.messages]
    : [
        ...(opts.system ? [{ role: "system", content: opts.system }] : []),
        ...(opts.user ? [{ role: "user", content: opts.user }] : []),
      ];
  const body = {
    model: opts.model || MODEL,
    messages,
    temperature: opts.temperature ?? 0.85,
    max_tokens: opts.maxTokens ?? 1600,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`模型调用失败 ${res.status}: ${t.slice(0, 300)}`);
  }
  const json = await res.json();
  const msg = json.choices?.[0]?.message ?? {};
  return {
    content: msg.content ?? "",
    reasoning: msg.reasoning_content ?? "",
    usage: json.usage ?? {},
  };
}

/**
 * 解析 JSON 输出（带容错：剥离 ```json 包裹、截断修复）
 */
// 消毒：把字符串字面量内的裸换行/制表符转义（推理模型常输出非法 JSON）
function sanitizeJsonStrings(s) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr) {
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

export function parseJsonLoose(text) {
  if (!text) return null;
  let s = text.trim();
  // 剥离代码块包裹
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) s = fence[1].trim();
  // 找第一个 JSON 对象/数组
  const start = s.search(/[{[]/);
  if (start > 0) s = s.slice(start);
  try {
    return JSON.parse(s);
  } catch {}
  // 截断修复 1：从尾向前找最后一个可解析的前缀
  for (let i = s.length - 1; i > 0; i--) {
    if (s[i] === "}" || s[i] === "]") {
      try {
        return JSON.parse(s.slice(0, i + 1));
      } catch {}
    }
  }
  // 截断修复 2：先消毒字符串内的裸控制字符，再补齐缺失的右括号（应对 max_tokens 截断）
  s = sanitizeJsonStrings(s);
  try {
    return JSON.parse(s);
  } catch {}
  let brace = 0, bracket = 0, inStr = false, esc = false;
  for (const ch of s) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") brace++;
    else if (ch === "}") brace--;
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket--;
  }
  if (brace > 0 || bracket > 0 || inStr) {
    let t = s;
    if (inStr) t += '"';                     // 字符串被截断在引号中间
    t = t.replace(/[\s,]+$/, "");            // 去掉残留尾部逗号/空白
    const repair = "}".repeat(Math.max(0, brace)) + "]".repeat(Math.max(0, bracket));
    try {
      return JSON.parse(t + repair);
    } catch {}
  }
  return null;
}

/**
 * 兼容导出：chatJsonStream（探照灯等模块在用）
 * 底层走 /responses（有界推理），接受旧参数名 maxTokens / json；
 * 空内容时内部升级重试（low + 大预算 → chat/completions 兜底）。
 */
export async function chatJsonStream(opts = {}, onDelta) {
  const base = {
    ...opts,
    maxOutput: opts.maxOutput ?? opts.maxTokens ?? 4000,
  };
  let r = await responsesStream(
    { ...base, effort: opts.effort ?? "low" },
    onDelta
  );
  if (!r.content) {
    r = await responsesStream(
      { ...base, effort: "low", maxOutput: Math.max(base.maxOutput, 9000) },
      onDelta
    );
  }
  if (!r.content) {
    r = await chatStream(
      {
        system: opts.system,
        user: opts.user,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.7,
        maxTokens: opts.maxTokens ?? 4000,
        json: opts.json,
      },
      onDelta
    );
  }
  return { ...r, parsed: parseJsonLoose(r.content) };
}

/**
 * 兼容导出：chatStream（纯文本流式，用于不需要 JSON 的场景）
 */
export { responsesStream as chatStreamEx };
export async function chatJson(opts = {}) {
  const tries = opts.tries ?? 2;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    const r = await chat({ ...opts, json: true }).catch((e) => {
      lastErr = e;
      return null;
    });
    if (!r) continue;
    const parsed = parseJsonLoose(r.content);
    if (parsed) return { ...r, parsed };
    lastErr = new Error("JSON 解析失败: " + r.content.slice(0, 200));
  }
  throw lastErr ?? new Error("chatJson 失败");
}

/**
 * 流式对话。onDelta(text, isReasoning) 逐 token 回调。
 */
export async function chatStream(opts = {}, onDelta) {
  const messages = opts.messages
    ? [...opts.messages]
    : [
        ...(opts.system ? [{ role: "system", content: opts.system }] : []),
        ...(opts.user ? [{ role: "user", content: opts.user }] : []),
      ];
  const body = {
    model: opts.model || MODEL,
    messages,
    temperature: opts.temperature ?? 0.9,
    max_tokens: opts.maxTokens ?? 2200,
    stream: true,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(`模型流式调用失败 ${res.status}: ${t.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  let reasoning = "";
  let finishReason = null;
  let usage = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      const payload = l.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const choice = j.choices?.[0] ?? {};
        const delta = choice.delta ?? {};
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (j.usage) usage = j.usage;
        if (typeof delta.content === "string" && delta.content.length) {
          full += delta.content;
          onDelta?.(delta.content, false);
        }
        if (
          typeof delta.reasoning_content === "string" &&
          delta.reasoning_content.length
        ) {
          reasoning += delta.reasoning_content;
          onDelta?.(delta.reasoning_content, true);
        }
      } catch {}
    }
  }
  if (!full) {
    console.warn(
      `[chatStream] 空内容 finish=${finishReason} usage=${JSON.stringify(usage)} reasonLen=${reasoning.length}`
    );
  }
  return { content: full, reasoning, finishReason, usage };
}

/**
 * /v1/responses 端点调用（支持 reasoning.effort，防止推理链吃光预算）
 * reasoning.effort: low / medium —— 思考强度
 */
function buildInput(opts) {
  if (opts.messages) return [...opts.messages];
  const items = [];
  if (opts.system) items.push({ role: "system", content: opts.system });
  if (opts.user) items.push({ role: "user", content: opts.user });
  return items;
}

/**
 * 流式调用 /responses。onDelta(text, isReasoning)
 */
export async function responsesStream(opts = {}, onDelta) {
  const body = {
    model: opts.model || MODEL,
    input: buildInput(opts),
    stream: true,
    reasoning: { effort: opts.effort || "medium" },
    max_output_tokens: opts.maxOutput ?? 6000,
  };
  let res;
  try {
    res = await fetch(`${BASE_URL}/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
  } catch (e) {
    // 网络错：退回 chat/completions
    return chatStream(
      {
        system: opts.system,
        user: opts.user,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.9,
        maxTokens: opts.maxOutput ?? 2200,
        json: opts.json,
      },
      onDelta
    );
  }
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    // 端点不支持时退回 chat/completions
    return chatStream(
      {
        system: opts.system,
        user: opts.user,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.9,
        maxTokens: opts.maxOutput ?? 2200,
        json: opts.json,
      },
      onDelta
    );
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  let reasoning = "";
  let finishReason = null;
  let usage = null;
  const linesAcc = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      const payload = l.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        switch (j.type) {
          case "response.output_text.delta": {
            const d = j.delta || "";
            if (d) {
              full += d;
              onDelta?.(d, false);
            }
            break;
          }
          case "response.reasoning_text.delta": {
            const d = j.delta || "";
            if (d) {
              reasoning += d;
              onDelta?.(d, true);
            }
            break;
          }
          case "response.completed":
          case "response.done":
          case "response.failed":
            if (j.response?.usage) usage = j.response.usage;
            if (j.response?.status) finishReason = j.response.status;
            break;
        }
      } catch {}
    }
  }
  if (!full) {
    console.warn(
      `[responses] 空内容 status=${finishReason} usage=${JSON.stringify(usage)} reasonLen=${reasoning.length}`
    );
  }
  return { content: full, reasoning, finishReason, usage };
}

/**
 * /responses + JSON 结构化输出（流式收完再解析）
 * 单次调用；失败升级（low effort / 大预算）由调用方按通道带 reset 重试。
 */
export async function responsesJsonStream(opts = {}, onDelta) {
  const r = await responsesStream(opts, onDelta);
  return { ...r, parsed: parseJsonLoose(r.content) };
}
