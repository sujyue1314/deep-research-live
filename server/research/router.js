// 探照灯路由：挂在主 server 上，前缀 /api/research/*
import { API_KEY, MODEL } from "../config.js";
import { ResearchSession } from "./session.js";
import { runResearch } from "./agent.js";
import { runFollowup } from "./qa.js";
import { runMockResearch, runMockFollowup, MOCK_QUESTION } from "./mock.js";
import { saveSession, loadSession } from "./persistence.js";

const sessions = new Map();

// 持久化订阅：关键事件节流写，done 立即写
function attachSaveHooks(session) {
  session.subscribe((evt) => {
    if (evt.type === "done") saveSession(session, { immediate: true });
    else if (
      evt.type === "evidence" ||
      evt.type === "section" ||
      evt.type === "one-line" ||
      evt.type === "qa-done" ||
      evt.type === "conflict" ||
      evt.type === "state"
    ) {
      saveSession(session);
    }
  });
}

/**
 * 取会话：内存优先，未命中则从磁盘恢复（服务器重启后老链接仍可用）
 */
function getSession(id) {
  const cached = sessions.get(id);
  if (cached) return cached;
  const loaded = loadSession(id);
  if (!loaded) return null;
  sessions.set(id, loaded);
  attachSaveHooks(loaded); // 恢复的会话仍可通过追问变化
  return loaded;
}

function json(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(s || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function attachSse(req, res, session) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  const send = (evt) => res.write(`event: message\ndata: ${JSON.stringify(evt)}\n\n`);
  send({ type: "hello", researchId: session.id });
  // 断线重连：先回放历史事件，再订阅新事件
  session.replay(send);
  const unsub = session.subscribe(send);
  const heartbeat = setInterval(() => res.write(": hb\n\n"), 15000);
  const cleanup = () => {
    clearInterval(heartbeat);
    unsub();
  };
  req.on("close", cleanup);
  // 客户端已断开时写管道出错（EPIPE）不能让进程崩
  res.on("error", cleanup);
}

async function startResearchSession({ question, mode, mock }) {
  const useMock = mock === undefined ? !API_KEY : !!mock;
  const finalQuestion = useMock ? MOCK_QUESTION : String(question || "").trim();
  if (!finalQuestion) {
    return { error: "question 不能为空" };
  }
  const session = new ResearchSession({ question: finalQuestion, mode, mock: useMock });
  sessions.set(session.id, session);
  attachSaveHooks(session);
  // 异步启动，不阻塞 HTTP 响应
  const runner = useMock ? runMockResearch : runResearch;
  runner(session).catch((e) => {
    console.error(`[research] 会话 ${session.id} 异常:`, e);
    if (!session.closed) {
      session.emit({ type: "error", message: String(e?.message || e).slice(0, 200) });
      session.finish("error");
    }
  });
  return { id: session.id, mock: useMock, question: session.question, mode: session.mode };
}

/**
 * 处理研究相关路由；未命中返回 false
 */
export async function handleResearch(req, res, url, method) {
  // 启动调查
  if (url === "/api/research/start" && method === "POST") {
    const body = await readBody(req);
    const r = await startResearchSession({
      question: body.question,
      mode: body.mode,
      mock: body.mock,
    });
    if (r.error) return json(res, 400, { error: r.error }), true;
    return json(res, 200, r), true;
  }

  // 配置信息（前端据此决定是否自动演练模式）
  if (url === "/api/research/info" && method === "GET") {
    return json(res, 200, { hasKey: !!API_KEY, model: MODEL }), true;
  }

  // SSE 事件流
  const sseMatch = url.match(/^\/api\/research\/stream\/([\w-]+)$/);
  if (method === "GET" && sseMatch) {
    const s = getSession(sseMatch[1]);
    if (!s) return json(res, 404, { error: "调查不存在" }), true;
    return attachSse(req, res, s), true;
  }

  // 停止
  const stopMatch = url.match(/^\/api\/research\/([\w-]+)\/stop$/);
  if (method === "POST" && stopMatch) {
    const s = getSession(stopMatch[1]);
    if (!s) return json(res, 404, { error: "调查不存在" }), true;
    s.abort();
    s.emit({ type: "notice", text: "⏹ 已手动停止调查" });
    return json(res, 200, { ok: true }), true;
  }

  // 报告追问（报告完稿后解锁）
  const askMatch = url.match(/^\/api\/research\/([\w-]+)\/ask$/);
  if (method === "POST" && askMatch) {
    const s = getSession(askMatch[1]);
    if (!s) return json(res, 404, { error: "调查不存在" }), true;
    if (s.phase !== "done" || !s.evidence.length) {
      return json(res, 400, { error: "追问在报告完稿后解锁" }), true;
    }
    const body = await readBody(req);
    const q = String(body.question || "").trim();
    if (!q) return json(res, 400, { error: "question 不能为空" }), true;
    const runner = s.mock ? runMockFollowup : runFollowup;
    runner(s, q).catch((e) => {
      console.error(`[research] 追问异常:`, e);
      s.emit({ type: "notice", text: `追问失败：${String(e?.message || e).slice(0, 120)}` });
    });
    return json(res, 200, { ok: true }), true;
  }

  // 当前状态快照
  const stateMatch = url.match(/^\/api\/research\/([\w-]+)\/state$/);
  if (method === "GET" && stateMatch) {
    const s = getSession(stateMatch[1]);
    if (!s) return json(res, 404, { error: "调查不存在" }), true;
    return json(res, 200, { state: s.state }), true;
  }

  return false;
}
