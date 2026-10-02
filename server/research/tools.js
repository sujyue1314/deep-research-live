// 调查局工具箱：联网搜索 + 网页正文抓取
// 搜索提供者优先级：TAVILY_API_KEY > SERPER_API_KEY > DuckDuckGo HTML > Bing HTML
// 全部不依赖外部 npm 包，纯 fetch + 正则解析

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FETCH_TIMEOUT = 15000;

/* ---------- 安全防护 ---------- */

// 禁止抓取内网/本地地址，防止模型把 SSRF 玩出花
function isForbiddenUrl(raw) {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return true;
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      host.startsWith("169.254.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.startsWith("::1") ||
      host.endsWith(".local")
    ) {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

async function timedFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8", ...(opts.headers || {}) },
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 搜索提供者 ---------- */

async function searchTavily(query, limit, opts = {}) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return null;
  const body = { query, max_results: limit, search_depth: "basic" };
  // 交叉验证补搜专用：排除已知域名，逼迫异源结果
  if (Array.isArray(opts.excludeDomains) && opts.excludeDomains.length) {
    body.exclude_domains = [...new Set(opts.excludeDomains)];
  }
  // 时效限定（iter-9）：模型对最新动态类查询传 year/month/week/day
  if (opts.timeRange) {
    body.time_range = opts.timeRange;
  }
  const res = await timedFetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.warn(`[research.tools] tavily HTTP ${res.status}`);
    return null;
  }
  const data = await res.json().catch(() => null);
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.slice(0, limit).map((r) => ({
    title: String(r.title || "").trim(),
    url: String(r.url || "").trim(),
    snippet: String(r.content || "").slice(0, 300).trim(),
  }));
}

async function searchSerper(query, limit) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return null;
  const res = await timedFetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": key },
    body: JSON.stringify({ q: query, num: limit }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const organic = Array.isArray(data?.organic) ? data.organic : [];
  return organic.slice(0, limit).map((r) => ({
    title: String(r.title || "").trim(),
    url: String(r.link || "").trim(),
    snippet: String(r.snippet || "").slice(0, 300).trim(),
  }));
}

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Bing 把真实 URL 藏在 /ck/a 重定向的 u= 参数（base64url，前缀 a1）里，解码还原
function decodeBingUrl(href) {
  try {
    const clean = href.replace(/&amp;/g, "&");
    if (clean.includes("/ck/a")) {
      const m = clean.match(/[?&]u=a1([^&]+)/);
      if (m) {
        const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/").replace(/\.+/g, "");
        const decoded = Buffer.from(b64, "base64").toString("utf-8");
        if (/^https?:\/\//.test(decoded)) return decoded;
      }
    }
  } catch {}
  return href;
}

// 兜底 1：DuckDuckGo HTML 版
async function searchDdg(query, limit) {
  const res = await timedFetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  );
  if (!res.ok) return null;
  const html = await res.text();
  if (!html.includes("result__a")) return null;
  const rows = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) && rows.length < limit) {
    let href = m[1];
    const u = href.match(/[?&]uddg=([^&]+)/);
    if (u) {
      try {
        href = decodeURIComponent(u[1]);
      } catch {}
    }
    const title = stripTags(m[2]);
    if (!title || !href) continue;
    // 在这条链接附近找摘要
    const tail = html.slice(m.index, m.index + 3000);
    const snip = tail.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    rows.push({ title, url: href, snippet: stripTags(snip?.[1] || "") });
  }
  return rows.length ? rows : null;
}

// 兜底 2：DuckDuckGo Lite 版（不同页面结构，HTML 版失效时的候补）
async function searchDdgLite(query, limit) {
  const res = await timedFetch(
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
  );
  if (!res.ok) return null;
  const html = await res.text();
  if (!html.includes("result-link")) return null;
  const rows = [];
  const linkRe = /<a[^>]*rel="nofollow"[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) && rows.length < limit) {
    const title = stripTags(m[2]);
    if (!title) continue;
    const tail = html.slice(m.index, m.index + 2500);
    const snip = tail.match(/<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/);
    rows.push({ title, url: m[1], snippet: stripTags(snip?.[1] || "") });
  }
  return rows.length ? rows : null;
}

// 兜底 3：Bing HTML 版
async function searchBing(query, limit) {
  const res = await timedFetch(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${limit + 2}`,
  );
  if (!res.ok) return null;
  const html = await res.text();
  if (!html.includes("b_algo")) return null;
  const rows = [];
  const itemRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
  let m;
  while ((m = itemRe.exec(html)) && rows.length < limit) {
    const block = m[0];
    const link = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const title = stripTags(link[2]);
    if (!title) continue;
    const snip = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    rows.push({ title, url: decodeBingUrl(link[1]), snippet: stripTags(snip?.[1] || "") });
  }
  return rows.length ? rows : null;
}

// 兜底 4：SearxNG 公共实例（JSON API）
const SEARX_INSTANCES = [
  "https://searx.be",
  "https://search.ononoki.org",
  "https://searx.tiekoetter.com",
];
async function searchSearx(query, limit) {
  for (const base of SEARX_INSTANCES) {
    try {
      const res = await timedFetch(
        `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`,
      );
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      const results = Array.isArray(data?.results) ? data.results : [];
      if (!results.length) continue;
      return results.slice(0, limit).map((r) => ({
        title: String(r.title || "").trim(),
        url: String(r.url || "").trim(),
        snippet: String(r.content || "").slice(0, 300).trim(),
      }));
    } catch {
      // 实例不可用，试下一个
    }
  }
  return null;
}

/**
 * 搜索：依次尝试各提供者，第一个成功即返回
 * 每个 provider 的结果先经相关性过滤（剔除标题/摘要与查询零相关的垃圾页）
 * opts.excludeDomains：排除已知域名，用于交叉验证补搜（仅 Tavily 支持）
 * 结果按「查询+排除域名」内存缓存（展会反复问同一题时加速并省额度；
 * 异源补搜因 excludeDomains 不同会生成独立 key，永远走真实搜索）
 */
const SEARCH_CACHE = new Map();
const CACHE_CAP = 200;
let cacheStats = { hits: 0, misses: 0 };

function cacheKey(q, opts) {
  // timeRange 也参与 key（iter-9）：同词不同时效范围不能共享缓存
  return JSON.stringify([
    q,
    Array.isArray(opts?.excludeDomains) ? opts.excludeDomains : [],
    opts?.timeRange || null,
  ]);
}

export function clearSearchCache() {
  SEARCH_CACHE.clear();
  cacheStats = { hits: 0, misses: 0 };
}

export function searchCacheStats() {
  return { ...cacheStats, size: SEARCH_CACHE.size };
}

export async function webSearch(query, limit = 5, opts = {}) {
  const q = String(query || "").slice(0, 200);
  if (!q) return { results: [], provider: "none" };
  const key = cacheKey(q, opts);
  const cached = SEARCH_CACHE.get(key);
  if (cached) {
    cacheStats.hits += 1;
    return cached;
  }
  cacheStats.misses += 1;
  for (const [name, fn] of [
    ["tavily", searchTavily],
    ["serper", searchSerper],
    ["searx", searchSearx],
    ["duckduckgo", searchDdg],
    ["duckduckgo-lite", searchDdgLite],
    ["bing", searchBing],
  ]) {
    try {
      const rows = await fn(q, limit + 3, opts);
      if (!rows || !rows.length) continue;
      const kept = relevanceFilter(q, rows).slice(0, limit);
      if (kept.length) {
        const result = { results: kept, provider: name };
        // 只缓存非空的成功结果（瞬时失败不应粘连）
        if (SEARCH_CACHE.size >= CACHE_CAP) {
          SEARCH_CACHE.delete(SEARCH_CACHE.keys().next().value);
        }
        SEARCH_CACHE.set(key, result);
        return result;
      }
      console.warn(`[research.tools] ${name} 结果与查询零相关，尝试下一个提供者`);
    } catch (e) {
      console.warn(`[research.tools] 搜索提供者 ${name} 失败: ${String(e?.message || e)}`);
    }
  }
  return { results: [], provider: "none" };
}

/* ---------- 相关性过滤 ---------- */

function queryTokens(s) {
  const out = new Set();
  for (const seg of s.match(/[\u4e00-\u9fa5]+|[a-zA-Z0-9]+/g) || []) {
    if (/[\u4e00-\u9fa5]/.test(seg)) {
      for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
    } else if (seg.length >= 2) {
      out.add(seg.toLowerCase());
    }
  }
  return out;
}

function relevanceFilter(query, rows) {
  const allTok = queryTokens(query);
  if (!allTok.size) return rows;
  // 中文查询：必须至少命中一个中文词元（纯数字/年份不算数，否则日历类垃圾页会混入）
  const cjkTok = new Set([...allTok].filter((t) => /[\u4e00-\u9fa5]/.test(t)));
  const isCJK = cjkTok.size > 0;
  return rows.filter((r) => {
    const t = queryTokens(`${r.title} ${r.snippet}`);
    let hits = 0;
    let cjkHits = 0;
    for (const tk of allTok) {
      if (t.has(tk)) {
        hits++;
        if (cjkTok.has(tk)) cjkHits++;
      }
    }
    if (isCJK) return cjkHits >= 1;
    return hits >= 2;
  });
}

/* ---------- 网页正文抓取 ---------- */

function detectCharset(buf, text) {
  const meta = text.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  const cs = (meta?.[1] || "").toLowerCase();
  if (cs.includes("gb") || cs.includes("big5")) return cs.replace(/[^a-z0-9-]/g, "");
  return "utf-8";
}

function htmlToText(html) {
  // 优先正文容器
  const bodyM =
    html.match(/<article[\s\S]*?<\/article>/i) ||
    html.match(/<main[\s\S]*?<\/main>/i) ||
    html.match(/<body[\s\S]*?<\/body>/i);
  const zone = bodyM ? bodyM[0] : html;
  // 干掉噪声标签
  const cleaned = zone
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // 段落/标题/列表项间插入换行，保留结构
  const blocked = cleaned.replace(/<\/(p|div|h[1-6]|li|tr|section)>/gi, "\n");
  const text = stripTags(blocked).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return text;
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return stripTags(m?.[1] || "");
}

/**
 * 抓取网页正文，返回 { title, text, charset }
 */
export async function fetchPage(rawUrl, maxChars = 8000) {
  if (isForbiddenUrl(rawUrl)) {
    throw new Error("禁止抓取本地/内网地址");
  }
  let res;
  try {
    res = await timedFetch(rawUrl);
  } catch (e) {
    throw new Error(`页面请求失败: ${String(e?.message || e).slice(0, 80)}`);
  }
  if (!res.ok) throw new Error(`页面返回 ${res.status}`);
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  if (!ctype.includes("html") && !ctype.includes("text")) {
    throw new Error(`不支持的页面类型: ${ctype || "未知"}`);
  }
  const buf = await res.arrayBuffer();
  const probe = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, 4096));
  const charset = detectCharset(buf, probe);
  let html;
  try {
    html = new TextDecoder(charset === "utf-8" ? "utf-8" : charset, { fatal: false }).decode(buf);
  } catch {
    html = probe + new TextDecoder("utf-8").decode(buf.slice(4096));
  }
  const title = extractTitle(html) || rawUrl;
  const fullText = htmlToText(html);
  if (!fullText) throw new Error("页面没有可读正文");
  return {
    title,
    text: fullText.slice(0, maxChars),
    truncated: fullText.length > maxChars,
  };
}
