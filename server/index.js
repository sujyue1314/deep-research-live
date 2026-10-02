// HTTP 服务：现场调查局 research 路由 + REST/SSE 推送 + 静态前端
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, API_KEY } from "./config.js";
import { handleResearch } from "./research/router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  if (url === "/") url = "/research.html";
  if (url === "/research") url = "/research.html";
  // SPA 回退
  let p = path.join(root, url);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    p = path.join(root, "research.html");
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

  // 路由：现场调查局（/api/research/*，含 SSE 与断线回放）
  if (await handleResearch(req, res, url, m)) {
    return;
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
  console.log(`  · 现场调查局（Atria 深度研究 Demo）: http://127.0.0.1:5180/research.html`);
  console.log(`Atria 模型密钥: ${API_KEY ? "已加载" : "未找到（调查局将以后台演练模式运行；检查 ~/.dsh/.credentials.yaml）"}`);
});
