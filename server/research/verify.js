// 核验工具：引文原文校验、来源分级、年份抽取、独立来源计数
// 全部为无状态的纯函数，供 agent.js 在 save_evidence / write_section 时强制调用

const T1_HOSTS = [
  "gov.cn",
  "stats.gov.cn",
  "nobelprize.org",
  "un.org",
  "who.int",
  "wikipedia.org",
  "wikimedia.org",
  "news.cn",
  "xinhuanet.com",
  "people.com.cn",
  "cctv.com",
  "thepaper.cn",
  "yicai.com",
  "caixin.com",
  "nytimes.com",
  "bbc.com",
  "reuters.com",
  "bloomberg.com",
  "apnews.com",
  "nature.com",
  "science.org",
  "arxiv.org",
];

// 已知的用户生成内容平台：可读但不可单独支撑关键结论
const UGC_HOSTS = [
  "zhihu.com",
  "douban.com",
  "sohu.com",
  "163.com",
  "sina.com.cn",
  "qq.com",
  "toutiao.com",
  "baijiahao.baidu.com",
  "xiaohongshu.com",
  "bilibili.com",
  "weibo.com",
];

const TIER_META = {
  1: { label: "权威", cls: "t1" },
  2: { label: "一般", cls: "t2" },
  3: { label: "存疑", cls: "t3" },
};

export function hostOf(rawUrl) {
  try {
    return new URL(rawUrl).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 来源分级：官方/权威(1) → 一般(2) → UGC/存疑(3)
 */
export function pageTier(url, title = "") {
  const host = hostOf(url);
  if (!host) return { tier: 2, ...TIER_META[2] };
  // 各级政府与官方机构站点
  if (host.endsWith(".gov.cn") || host.includes(".gov.") || host === "gov.cn") {
    return { tier: 1, ...TIER_META[1] };
  }
  for (const h of T1_HOSTS) {
    if (host === h || host.endsWith("." + h)) return { tier: 1, ...TIER_META[1] };
  }
  for (const h of UGC_HOSTS) {
    if (host === h || host.endsWith("." + h)) return { tier: 3, ...TIER_META[3] };
  }
  // 科研与官方组织常见后缀
  if (host.endsWith(".edu.cn") || host.endsWith(".edu") || host.endsWith(".org")) {
    return { tier: 1, ...TIER_META[1] };
  }
  // 标题里带「官方网站」字样的常识性兜底
  if (/官方|官网|统计公报/.test(title || "")) return { tier: 1, ...TIER_META[1] };
  return { tier: 2, ...TIER_META[2] };
}

/**
 * 从标题/引文中抽取最近出现的年份（1990-2099）
 */
export function extractYear(...texts) {
  const s = texts.filter(Boolean).join(" ");
  const years = [...s.matchAll(/(?:19|20)(\d{2})/g)].map((m) => Number(m[0]));
  if (!years.length) return null;
  const latest = Math.max(...years);
  return latest >= 1990 && latest <= 2099 ? latest : null;
}

const PUNCT = /[【】「」『』“”"''',.;:!?，。；：！？、\s…\-—()（）\[\]（）]/g;

/**
 * 归一化：去标点与空白，用于引文包含校验
 */
function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(PUNCT, "");
}

/**
 * 引文核验：quote 是否确实出现在来源正文中（容许省略号、标点与排版差异）
 */
export function quoteInText(quote, text) {
  const q = normalize(quote);
  const t = normalize(text);
  if (!q || !t) return false;
  if (q.length < 6) return true; // 过短引文（数字/年份类）不做强制校验
  if (t.includes(q)) return true;
  // 省略号拼接的引文：逐段包含即可
  const parts = quote
    .split(/[…\.]{2,}|……|——/)
    .map((p) => normalize(p))
    .filter((p) => p.length >= 4);
  if (parts.length >= 2 && parts.every((p) => t.includes(p))) return true;
  return false;
}

/**
 * 独立来源计数：不同主域名数量
 */
export function distinctHostCount(urls) {
  return new Set(urls.map(hostOf).filter(Boolean)).size;
}

/**
 * 域名集合（用于展示交叉验证域名）
 */
export function distinctHosts(urls) {
  return [...new Set(urls.map(hostOf).filter(Boolean))];
}
