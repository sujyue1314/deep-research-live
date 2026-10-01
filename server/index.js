// HTTP 服务：会话管理 + REST 行动接口 + SSE 实时推送 + 静态前端
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, API_KEY } from "./config.js";
import { GameSession } from "./engine/game.js";
import { handleResearch } from "./research/router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessions = new Map();

// 开发期安全网：单个会话/SSE 管道异常不拖垮整个服务器
process.on("uncaughtException", (e) => {
  console.error("[uncaughtException]", e?.stack || e);
});
process.on("unhandledRejection", (e) => {
  console.error("[unhandledRejection]", e?.stack || e);
});

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

function getSession(id) {
  if (sessions.has(id)) return sessions.get(id);
  const s = GameSession.load(id);
  if (s) sessions.set(id, s);
  return s;
}

// SSE
function attachSse(req, res, session) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(`data: ${JSON.stringify({ type: "hello", gameId: session.state.id })}\n\n`);
  const unsub = session.on((evt) => {
    try {
      res.write(`event: message\ndata: ${JSON.stringify(evt)}\n\n`);
    } catch {
      unsub();
    }
  });
  const heartbeat = setInterval(() => {
    try {
      res.write(": hb\n\n");
    } catch {}
  }, 15000);
  const cleanup = () => {
    clearInterval(heartbeat);
    unsub();
    session.dropSubscriber();
  };
  req.on("close", cleanup);
  res.on("error", cleanup);
  session.addSubscriber();
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

function serveStatic(req, res) {
  const root = path.join(__dirname, "..", "dist");
  let url = req.url.split("?")[0];
  if (url === "/") url = "/index.html";
  if (url === "/research") url = "/research.html";
  // SPA 回退
  let p = path.join(root, url);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    p = path.join(root, "index.html");
  }
  try {
    const data = fs.readFileSync(p);
    res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(data);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  const m = req.method;

  // 路由：SSE
  const sseMatch = url.match(/^\/api\/stream\/([\w-]+)$/);
  if (m === "GET" && sseMatch) {
    const s = getSession(sseMatch[1]);
    if (!s) return json(res, 404, { error: "游戏不存在" });
    return attachSse(req, res, s);
  }

  // 路由：现场调查局（独立 Demo，与游戏路由互不干扰）
  if (await handleResearch(req, res, url, m)) {
    return;
  }

  // 路由：API
  if (url === "/api/new" && m === "POST") {
    const body = await readBody(req);
    const s = new GameSession({ mode: body.mode === "spectator" ? "spectator" : "normal" });
    sessions.set(s.state.id, s);
    s.save();
    return json(res, 200, { id: s.state.id, mode: s.state.mode });
  }

  if (url === "/api/games" && m === "GET") {
    const dir = path.join(__dirname, "saves");
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {}
    const games = files
      .map((f) => {
        try {
          const st = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          return {
            id: st.id,
            round: st.round,
            over: st.over,
            mode: st.mode,
            createdAt: st.createdAt,
            phase: st.phase,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
    return json(res, 200, { games });
  }

  const actMatch = url.match(/^\/api\/([\w-]+)\/(action|negotiate|start)$/);
  if (m === "POST" && actMatch) {
    const [, gid, op] = actMatch;
    const s = getSession(gid);
    if (!s) return json(res, 404, { error: "游戏不存在" });
    const body = await readBody(req);
    try {
      if (op === "start") {
        s.start();
        return json(res, 200, { ok: true });
      }
      if (op === "action") {
        const r = await s.playerAction(body.action || {});
        return json(res, r.ok ? 200 : 400, r);
      }
      if (op === "negotiate") {
        const r = await s.negotiate(body.npcId, body.text || "");
        return json(res, r.ok ? 200 : 400, r);
      }
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  const offerMatch = url.match(/^\/api\/([\w-]+)\/offer\/([\w-]+)$/);
  if (m === "POST" && offerMatch) {
    const [, gid, offerId] = offerMatch;
    const s = getSession(gid);
    if (!s) return json(res, 404, { error: "游戏不存在" });
    const body = await readBody(req);
    const r = s.decideOffer(offerId, !!body.accept);
    return json(res, r.ok ? 200 : 400, r);
  }

  const stateMatch = url.match(/^\/api\/([\w-]+)\/state$/);
  if (m === "GET" && stateMatch) {
    const s = getSession(stateMatch[1]);
    if (!s) return json(res, 404, { error: "游戏不存在" });
    return json(res, 200, { state: s.state });
  }

  if (url === "/api/health" && m === "GET") {
    return json(res, 200, { ok: true, model: !!API_KEY });
  }

  if (m === "GET") {
    return serveStatic(req, res);
  }
  json(res, 404, { error: "unknown route" });
});

server.listen(PORT, () => {
  console.log(`服务端已启动: http://127.0.0.1:${PORT}`);
  console.log(`  · 大富翁·名利场（经典版）: http://127.0.0.1:5180/`);
  console.log(`  · 现场调查局（Atria 深度研究 Demo）: http://127.0.0.1:5180/research.html`);
  console.log(`Atria 模型密钥: ${API_KEY ? "已加载" : "未找到（调查局将以后台演练模式运行；检查 ~/.dsh/.credentials.yaml）"}`);
});
