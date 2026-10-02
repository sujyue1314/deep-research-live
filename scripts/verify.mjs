// 现场调查局 · 回归验证套件
// 用法：node scripts/verify.mjs <mock|fire|qa|ui|cache> [参数]
// 环境变量：DEMO_BASE（默认 http://127.0.0.1:5180）、TAVILY_API_KEY（fire/qa/cache 需要）
//
//   mock [strict|quick|both]  SSE 控制台断言（离线 mock 轨迹，不消耗 API）
//   fire                      交叉验证守卫手术式测试（真实模型 + 真实 Tavily）
//   qa                        报告追问手术式测试（真实模型：范围内引用 / 范围外诚实拒答）
//   ui                        puppeteer 全流程回归（守卫卡 + 双向联动 + 打印 + 追问）
//   cache                     搜索缓存单元测试（真实 Tavily）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Windows 上动态 import 绝对路径必须是 file:// URL
const importAbs = (p) => import(pathToFileURL(p).href);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.DEMO_BASE || "http://127.0.0.1:5180";
const SHOTS = path.join(ROOT, ".shots");
fs.mkdirSync(SHOTS, { recursive: true });

const mode = process.argv[2] || "mock";
const arg = process.argv[3] || "both";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- SSE 客户端 ---------- */

// until 谓词：收到匹配事件即结束订阅（research 流靠心跳常开，不会自行关闭）
async function subscribeSSE(url, onEvent, until) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SSE 连接失败 ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (line.startsWith("data:")) {
          try {
            const ev = JSON.parse(line.slice(5).trim());
            onEvent(ev);
            if (until?.(ev)) return;
          } catch {}
        }
      }
    }
  }
}

async function startSession(qOpts) {
  const r = await fetch(`${BASE}/api/research/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(qOpts),
  }).then((x) => x.json());
  if (r.error) throw new Error(`start 失败: ${r.error}`);
  return r;
}

/* ---------- 模式 1：mock 控制台断言 ---------- */

async function verifyMock(which) {
  const runs = which === "both" ? ["strict", "quick"] : [which];
  let allFail = [];
  for (const m of runs) {
    console.log(`\n===== mock ${m} =====`);
    const r = await startSession({
      question: "上海近十年常住人口变化与背后原因",
      mode: m,
      mock: true,
    });
    console.log(`[session ${r.id}]`);
    const evts = [];
    await subscribeSSE(
      `${BASE}/api/research/stream/${r.id}`,
      (ev) => {
        evts.push(ev);
        if (ev.type === "evidence") console.log(`  证据 #${ev.index} [${ev.tierLabel}/${ev.year}] ${ev.url}`);
        else if (ev.type === "challenge" && ev.kind === "diversity")
          console.log(`  [守卫] host=${ev.host} query=${ev.query}`);
        else if (ev.type === "notice") console.log(`  notice: ${ev.text}`);
        else if (ev.type === "section") console.log(`  第 ${ev.index} 节 conf=${ev.confidence} cross=${ev.crossVerified}`);
      },
      (ev) => ev.type === "done" || ev.type === "error",
    );
    const fail = [];
    const ok = (cond, msg) => (cond ? console.log("  ✓", msg) : (fail.push("✗ " + msg), console.log("  ✗", msg)));
    const ev = (t) => evts.filter((e) => e.type === t);
    const evidence = ev("evidence");

    ok(evts.some((e) => e.type === "done"), "收到 done 事件");
    ok(!evts.some((e) => e.type === "error"), "零 error");

    if (m === "strict") {
      const div = ev("challenge").find((c) => c.kind === "diversity");
      ok(!!div && !!div.host && !!div.query, "守卫卡（单一域名 + 检索词）");
      ok(evts.some((e) => e.type === "notice" && e.text.includes("异源补搜成功")), "补搜成功 notice");
      ok(evts.some((e) => e.type === "notice" && e.text.includes("日期锚点")), "日期锚点 notice（iter-9）");
      ok(evidence.length === 5, `证据 5 条（实际 ${evidence.length}）`);
      const hosts = new Set(evidence.map((e) => new URL(e.url).host));
      ok(hosts.size >= 3, `跨 ${hosts.size} 域名`);
      const secs = ev("section");
      ok(secs.length === 3, `3 节报告（实际 ${secs.length}）`);
      ok(evts.some((e) => e.type === "verdict"), "裁决存在");
    } else {
      ok(evts.some((e) => e.type === "notice" && e.text.includes("日期锚点")), "日期锚点 notice（iter-9）");
      ok(evidence.length === 4, `证据 4 条（实际 ${evidence.length}）`);
      const secs = ev("section");
      ok(secs.length === 3, `3 节报告（实际 ${secs.length}）`);
      ok(!ev("challenge").some((c) => c.kind === "diversity"), "跨域名证据不误触守卫");
      ok(evts.some((e) => e.type === "one-line"), "one-line 结论");
    }
    allFail.push(...fail);
  }
  console.log("\nmock 汇总:", allFail.length ? `FAIL (${allFail.length})` : "PASS");
  return allFail.length === 0;
}

/* ---------- 模式 2：守卫手术式（真实模型） ---------- */

async function verifyFire() {
  const { ResearchSession } = await importAbs(path.join(ROOT, "server/research/session.js"));
  const { runSkeptic } = await importAbs(path.join(ROOT, "server/research/agent.js"));
  if (!process.env.TAVILY_API_KEY) throw new Error("需要 TAVILY_API_KEY");

  const session = new ResearchSession({
    question: "2024年上海市国民经济和社会发展统计公报中的全市GDP增速是多少",
    mode: "strict",
  });
  const base = "https://tjj.sh.gov.com/tjgb/";
  [
    {
      id: "e1", index: 1, url: `${base}20250329/abc123.html`,
      title: "2024年上海市国民经济和社会发展统计公报",
      quote: "至2024年末，全市常住人口2480.5万人，比上年减少7.0万人。",
      note: "官方总量数据。", tier: 1, tierLabel: "权威", verified: true, year: 2024,
    },
    {
      id: "e2", index: 2, url: `${base}20240320/def456.html`,
      title: "2023年上海市国民经济和社会发展统计公报",
      quote: "至2023年末，全市常住人口2487.45万人，比上年增加11.5万人。",
      note: "对照数据。", tier: 1, tierLabel: "权威", verified: true, year: 2023,
    },
  ].forEach((e) => {
    session.evidence.push(e);
    session.noteKnown(e.url);
    session.noteContext(e.url, `${e.title} ${e.quote}`);
  });

  const events = [];
  session._bus.on("event", (e) => events.push(e));
  const t0 = Date.now();
  const res = await runSkeptic(session);
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("diversity:", JSON.stringify(res.diversity));

  const fail = [];
  const ok = (cond, msg) => (cond ? console.log("  ✓", msg) : (fail.push("✗ " + msg), console.log("  ✗", msg)));
  ok(events.some((e) => e.type === "challenge" && e.kind === "diversity"), "守卫卡已发射");
  ok(!!res.diversity?.query, "质疑者输出异源检索词");
  ok(res.diversity?.tried, "系统执行了补搜");
  ok(res.diversity?.succeeded, "补搜成功引入新域名");
  ok(!events.some((e) => e.type === "error"), "零 error");
  // iter-9 时效性
  const { isTimeSensitive } = await importAbs(path.join(ROOT, "server/research/agent.js"));
  ok(isTimeSensitive("今年上海常住人口最新数据"), "时效判定：相对时间词");
  ok(isTimeSensitive(`${new Date().getFullYear()} 年主流大模型`), "时效判定：当前年份");
  ok(!isTimeSensitive("上海近十年常住人口变化"), "时效判定：历史问题不算时效敏感");
  console.log(fail.length ? "fire: FAIL" : "fire: PASS");
  return fail.length === 0;
}

/* ---------- 模式 3：追问手术式（真实模型） ---------- */

async function verifyQa() {
  const { ResearchSession } = await importAbs(path.join(ROOT, "server/research/session.js"));
  const { runFollowup } = await importAbs(path.join(ROOT, "server/research/qa.js"));

  const session = new ResearchSession({
    question: "上海近十年常住人口变化与背后原因",
    mode: "strict",
  });
  session.mock = false;
  session.phase = "done";
  [
    {
      id: "e1", index: 1, url: "https://tjj.sh.gov.cn/tjgb/20250329/abc123.html",
      title: "2024年上海市国民经济和社会发展统计公报",
      quote: "至2024年末，全市常住人口2480.5万人，比上年减少7.0万人。其中，户籍常住人口1480.2万人，外来常住人口1000.3万人。",
      note: "官方总量数据。", tier: 1, tierLabel: "权威", verified: true, year: 2024,
    },
    {
      id: "e2", index: 2, url: "https://www.yicai.com/news/102345678.html",
      title: "上海户籍人口连年增长，外来人口回落 - 第一财经",
      quote: "2024年户籍人口达1480.2万，较2014年增约160万；外来常住人口从千万峰值回落。",
      note: "结构证据。", tier: 1, tierLabel: "权威", verified: true, year: 2024,
    },
  ].forEach((e) => {
    session.evidence.push(e);
    session.noteKnown(e.url);
    session.noteContext(e.url, `${e.title} ${e.quote}`);
  });
  session.sections.push({
    index: 1, heading: "总量曲线与结构分化",
    markdown: "2024 年末常住人口 2480.5 万，净减少 7.0 万 [1]；户籍与外来人口一升一降 [2]。",
    citations: [], crossVerified: true,
  });

  await runFollowup(session, "2024年户籍人口是多少？");
  console.log("范围内答案:", session.qa[0].a.slice(0, 120), "…");
  await runFollowup(session, "北京2024年GDP增速是多少？");
  console.log("范围外答案:", session.qa[1].a.slice(0, 120), "…");

  const fail = [];
  const ok = (cond, msg) => (cond ? console.log("  ✓", msg) : (fail.push("✗ " + msg), console.log("  ✗", msg)));
  const cite1 = [...session.qa[0].a.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  ok(cite1.some((n) => n >= 1 && n <= 2), `范围内带合法引用 ${cite1}`);
  const honest2 = /证据不足|无法|超出|没有.{0,6}(数据|证据|记录)/.test(session.qa[1].a);
  ok(honest2, "范围外诚实声明");
  ok(session.qa.length === 2, `两条问答记录（实际 ${session.qa.length}）`);
  ok(!session.qa.some((x) => [...x.a.matchAll(/\[(\d+)\]/g)].some((m) => Number(m[1]) > 2)), "无非法引用");
  console.log(fail.length ? "qa: FAIL" : "qa: PASS");
  return fail.length === 0;
}

/* ---------- 模式 4：UI 全流程回归（puppeteer） ---------- */

async function verifyUi() {
  const puppeteer = (await import("puppeteer-core")).default;
  const LOG = path.join(SHOTS, "verify-ui.log");
  fs.writeFileSync(LOG, "");
  const log = (...a) => fs.appendFileSync(LOG, a.join(" ") + "\n");
  const errors = [];

  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--window-size=1600,900"],
    protocolTimeout: 60000,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });

  log("1) mock + strict 启动");
  await page.goto(`${BASE}/research.html`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.click(".ib-chip");
  await page.click(".ib-mock input");
  await page.click(".ib-mode .ib-seg:last-child");
  await page.click(".rb-btn-primary");

  log("2) 等守卫卡");
  await page.waitForSelector(".tr-challenge.cross", { timeout: 200000 });
  const cross = await page.evaluate(() => {
    const el = document.querySelector(".tr-challenge.cross");
    return {
      host: el.querySelector(".host-chip")?.textContent,
      query: el.querySelector(".tr-ch-query")?.textContent?.slice(0, 40),
    };
  });
  log("   守卫卡:", JSON.stringify(cross));

  log("3) 等报告完成 → 双向联动");
  await page.waitForSelector(".doc-verdict-text", { timeout: 200000 }); // iter-17：rp-online → 裁决段
  await sleep(1500);
  await page.evaluate(() => {
    const card = [...document.querySelectorAll(".ev-card")].find(
      (c) => c.querySelector(".ev-no")?.textContent === "2",
    );
    card?.click();
  });
  await sleep(600);
  const link = await page.evaluate(() => ({
    hl: document.querySelectorAll(".md-cite.hl").length,
    active: document.querySelectorAll(".ev-card.ev-active").length,
  }));
  log("   联动:", JSON.stringify(link));
  await page.evaluate(() => {
    const card = [...document.querySelectorAll(".ev-card")].find(
      (c) => c.querySelector(".ev-no")?.textContent === "2",
    );
    card?.click();
  });
  await sleep(300);
  const toggled = await page.evaluate(() => document.querySelectorAll(".md-cite.hl").length);
  log("   取消后 hl:", toggled);

  log("4) 打印");
  const hasBtn = (await page.$(".rb-print-btn")) != null;
  let pdfOk = false;
  try {
    await page.pdf({ path: path.join(SHOTS, "report.pdf"), format: "A4", printBackground: true });
    pdfOk = fs.statSync(path.join(SHOTS, "report.pdf")).size > 10000;
  } catch (e) {
    log("   pdf 失败:", e?.message);
  }
  await page.emulateMediaType("print");
  const printProbe = await page.evaluate(() => {
    const cs = (s) => (document.querySelector(s) ? getComputedStyle(document.querySelector(s)).display : null);
    return {
      left: cs(".rb-col-left"), inputbar: cs(".rb-inputbar"),
      report: cs(".rb-report"), board: cs(".rb-board"), printBtn: cs(".rb-print-btn"),
    };
  });
  log("   打印媒体:", JSON.stringify(printProbe));
  await page.emulateMediaType("screen");

  log("5) 追问（范围内 + 范围外）");
  await page.waitForSelector(".rb-qa-form", { timeout: 15000 });
  const askAndWait = async (text) => {
    const before = await page.$$eval(".qa-item", (els) => els.length);
    await page.type(".rb-qa-input", text);
    await page.click(".rb-qa-send");
    await page.waitForFunction(
      (n) => {
        const items = document.querySelectorAll(".qa-item");
        if (items.length < n + 1) return false;
        const last = items[items.length - 1];
        const a = last.querySelector(".qa-a");
        return !!a && !last.querySelector(".tr-caret") && a.textContent.length > 10;
      },
      { timeout: 60000 },
      before,
    );
    return page.evaluate(() => {
      const last = document.querySelectorAll(".qa-item")[document.querySelectorAll(".qa-item").length - 1];
      return {
        a: last.querySelector(".qa-a")?.textContent?.trim(),
        chips: [...last.querySelectorAll(".md-cite")].map((c) => c.textContent),
      };
    });
  };
  const qa1 = await askAndWait("2024年人口减少了多少？");
  log("   范围内:", JSON.stringify(qa1).slice(0, 160));
  const qa2 = await askAndWait("北京人口是多少？");
  log("   范围外:", JSON.stringify(qa2).slice(0, 160));
  // C3 排版探针：完稿印 / 首字下沉候选 / thin space 生效（U+2009 = 8201）
  // iter-17：公报原型 —— .rp-end-mark → .doc-seal-ring；.rp-online → .doc-verdict-text
  const typo = await page.evaluate(() => ({
    endMark: !!document.querySelector(".doc-seal-ring"),
    dc: !!document.querySelector(".doc-verdict-text.rp-dc"),
    thin: [...document.querySelectorAll(".rp-line, .doc-verdict-text")].reduce(
      (n, el) => n + [...el.textContent].filter((c) => c.charCodeAt(0) === 8201).length,
      0,
    ),
    // iter-17 公报文书探针
    doc: {
      head: !!document.querySelector(".doc-head"),
      verdict: document.querySelector(".doc-verdict-text")?.textContent.slice(0, 24),
      findings: document.querySelectorAll(".doc-finding").length,
      conflict: !!document.querySelector(".doc-conflict"),
      appendixRows: document.querySelectorAll(".doc-ev-row").length,
      evCount: document.querySelectorAll(".ev-card").length,
      qaRestyled: document.querySelector(".rb-qa-head span")?.textContent,
    },
  }));
  log("   C3:", JSON.stringify(typo));
  // 几何探针（iter-7）：报告面板高度占比 —— 右栏原则/计划面板不得把报告挤瘪
  // iter-14 扩展：完稿后计划屉应收起（只占头部一行），报告占比应更高
  const geo = await page.evaluate(() => {
    const col = document.querySelector(".rb-col-right");
    const report = document.querySelector(".rb-report");
    const rb = document.querySelector(".rb-report-body");
    if (!col || !report) return null;
    const cr = col.getBoundingClientRect();
    const rr = report.getBoundingClientRect();
    return {
      colH: Math.round(cr.height),
      reportH: Math.round(rr.height),
      reportBodyH: rb ? Math.round(rb.getBoundingClientRect().height) : null,
      planItemsVisible: document.querySelectorAll(".rb-plan-list .pl-item").length,
      planCaret: document.querySelector(".rb-plan-caret")?.textContent,
      trajAtBottom: (() => {
        const l = document.querySelector(".rb-traj-list");
        if (!l) return null;
        return l.scrollTop + l.clientHeight >= l.scrollHeight - 64;
      })(),
    };
  });
  log("   几何:", JSON.stringify(geo));
  // iter-14：屉交互 —— 点击展开应看到全部计划项
  await page.click(".rb-plan-toggle").catch(() => {});
  await sleep(400);
  const planOpen = await page.evaluate(() => ({
    visible: document.querySelectorAll(".rb-plan-list .pl-item").length,
    caret: document.querySelector(".rb-plan-caret")?.textContent,
  }));
  log("   计划屉展开:", JSON.stringify(planOpen));
  // 截断探针（iter-11）：末节正文必须完整收尾（旧 bug：关闭后 chunk 队列被截）
  const trunc = await page.evaluate(() => {
    const md = document.querySelectorAll(".rp-md");
    if (!md.length) return null;
    const last = md[md.length - 1];
    const t = last.textContent.replace(/\s+$/, "");
    return { len: t.length, tail: t.slice(-6) };
  });
  log("   末节:", JSON.stringify(trunc));
  // 无英文残留探针（iter-8）：固定界面标签不得含拉丁字母
  const latinFree = await page.evaluate(() => {
    const sels = [
      ".rb-kicker",
      ".rb-sub",
      ".rb-title",
      ".rb-panel-head > span",
      ".rb-online-tag",
      ".rb-qa-head > span",
    ];
    return sels
      .map((s) => [...document.querySelectorAll(s)].map((el) => el.textContent).join(" "))
      .join(" ");
  });
  // iter-9 日期锚点：轨迹里可见
  const anchor = await page.evaluate(
    () => document.querySelector(".rb-traj")?.textContent.includes("日期锚点") ?? false,
  );
  await page.screenshot({ path: path.join(SHOTS, "verify-final.png") });

  // iter-15 交互探针（须在 browser.close() 之前：涉及真实点击与取值）
  const it15 = await page.evaluate(() => ({
    stageOn: document.querySelector(".rb-grid")?.className.includes("rb-grid-stage-report") ?? false,
    arrowBtns: document.querySelectorAll(".ib-scroll-btn").length,
    stageSwitch: !!document.querySelector(".rb-stage-switch"),
  }));
  log("   iter-15:", JSON.stringify(it15));
  await page.click(".rb-stage-switch .ib-seg:last-of-type").catch(() => {});
  await sleep(500);
  const processGear = await page.evaluate(() => {
    const l = document.querySelector(".rb-traj-list");
    return {
      stageOff: !document.querySelector(".rb-grid")?.className.includes("rb-grid-stage-report"),
      trajNoHOverflow: l ? l.scrollWidth <= l.clientWidth + 2 : null,
    };
  });
  // 箭头滚动是 smooth 动画 —— 点击后等动画再读
  const arrowBefore = await page.evaluate(() => document.querySelector(".ib-presets")?.scrollLeft ?? 0);
  await page.evaluate(() => [...document.querySelectorAll(".ib-scroll-btn")].pop()?.click());
  await sleep(1000);
  const arrowAfter = await page.evaluate(() => document.querySelector(".ib-presets")?.scrollLeft ?? 0);
  processGear.arrowsWork = { before: arrowBefore, after: arrowAfter };
  log("   过程视图:", JSON.stringify(processGear));

  await browser.close();
  log("页面错误:", errors.length ? errors.slice(0, 3) : "无");

  const fail = [];
  const ok = (cond, msg) => (cond ? log("  ✓", msg) : fail.push("✗ " + msg));
  ok(!!cross.host && !!cross.query, "守卫卡渲染（host+query）");
  ok(link.hl >= 2 && link.active === 1, `双向联动 hl=${link.hl} active=${link.active}`);
  ok(toggled === 0, "联动取消");
  ok(hasBtn && pdfOk, "打印按钮 + PDF 生成");
  ok(printProbe.left === "none" && printProbe.inputbar === "none" && printProbe.printBtn === "none", "打印媒体隐藏多余栏");
  ok(printProbe.report !== "none" && printProbe.board !== "none", "打印媒体保留报告+证据");
  ok(qa1.a.includes("2480.5") && qa1.chips.length >= 1, "范围内追问带数据+引用");
  ok(/无法|没有.{0,6}(记录|数据|证据)/.test(qa2.a), "范围外追问诚实拒答");
  ok(typo.endMark, "完稿印（C3）");
  ok(typo.dc, "首字下沉候选（C3）");
  ok(typo.thin > 0, `中英文 thin space 生效（${typo.thin} 处，C3）`);
  ok(typo.doc?.head && !!typo.doc?.verdict, "文号头 + 裁决段（iter-17 公报）");
  ok(typo.doc?.findings === 3, `认定 3 条（实际 ${typo.doc?.findings}，iter-17）`);
  ok(typo.doc?.appendixRows === typo.doc?.evCount, `附录证据清单与证据板一致（${typo.doc?.appendixRows} 行，iter-17）`);
  ok(!!typo.doc?.qaRestyled && typo.doc.qaRestyled === "答记者问", "追问改「答记者问」（iter-17）");
  ok(geo && geo.reportH >= 0.45 * geo.colH, `报告面板占右栏 ≥45%（${geo?.reportH}/${geo?.colH}，iter-7）`);
  ok(geo?.planItemsVisible === 0 && geo?.planCaret === "▸", `完稿后计划屉自动收起（iter-14，${geo?.planItemsVisible}项可见/${geo?.planCaret}）`);
  ok(planOpen.visible >= 3 && planOpen.caret === "▾", `屉点击展开恢复全部计划（iter-14，${planOpen.visible}项）`);
  ok(geo?.trajAtBottom === true, "直播流完稿时贴底（iter-14 修复跟随目标）");

  ok(it15.stageSwitch && it15.stageOn, "完稿自动进入报告舞台（iter-15）");
  ok(processGear.stageOff, "舞台可切回全过程（iter-15）");
  ok(processGear.trajNoHOverflow === true, "时间线无横向溢出（iter-15）");
  ok(
    processGear.arrowsWork && processGear.arrowsWork.after > processGear.arrowsWork.before,
    `灵感条箭头可滚动（${processGear.arrowsWork?.before}→${processGear.arrowsWork?.after}，iter-15）`,
  );
  ok(
    !!trunc && /[。！？）】”]/.test(trunc?.tail?.slice(-1) || ""),
    `末节完整收尾（…${trunc?.tail}，iter-11）`,
  );
  ok(!/[A-Za-z]/.test(latinFree), "界面标签无英文残留（iter-8）");
  ok(anchor, "轨迹含日期锚点（iter-9）");
  ok(errors.filter((e) => !e.includes("404")).length === 0, "无页面错误（favicon 404 除外）");
  fail.forEach((f) => log(" ", f));
  log(fail.length ? "ui: FAIL" : "ui: PASS");
  return fail.length === 0;
}

/* ---------- 模式 5：缓存单元测试（真实 Tavily） ---------- */

async function verifyCache() {
  const { webSearch, clearSearchCache, searchCacheStats } = await importAbs(
    path.join(ROOT, "server/research/tools.js"),
  );
  if (!process.env.TAVILY_API_KEY) throw new Error("需要 TAVILY_API_KEY");
  clearSearchCache();
  const q = "上海 常住人口 2024 统计公报";
  const t0 = Date.now();
  const a = await webSearch(q, 5);
  const t1 = Date.now() - t0;
  const b = await webSearch(q, 5);
  const stats = searchCacheStats();
  const t2 = Date.now() - t0 - t1;
  console.log(`首次 ${t1}ms / 命中 ${t2}ms`);
  console.log("stats:", JSON.stringify(stats));

  const fail = [];
  const ok = (cond, msg) => (cond ? console.log("  ✓", msg) : (fail.push("✗ " + msg), console.log("  ✗", msg)));
  ok(a.results.length > 0 && a.provider !== "none", `首次真实搜索成功（provider=${a.provider}）`);
  ok(stats.hits === 1, `第二次命中缓存（hits=${stats.hits}）`);
  ok(JSON.stringify(a) === JSON.stringify(b), "两次结果完全一致");
  ok(t2 < t1, `缓存更快（${t2}ms < ${t1}ms）`);
  // excludeDomains 变体使用独立 key：永远真实搜索
  const c = await webSearch(q, 5, { excludeDomains: ["tjj.sh.gov.cn"] });
  const stats2 = searchCacheStats();
  ok(stats2.hits === 1 && stats2.misses === 2, `异源补搜（excludeDomains）不读缓存（misses=${stats2.misses}）`);
  ok(c.results.length > 0, "异源补搜仍有结果");
  // timeRange 变体独立 key（iter-9）：时效限定不与无限制查询共享缓存
  const d = await webSearch(q, 5, { timeRange: "year" });
  const stats3 = searchCacheStats();
  ok(stats3.hits === 1 && stats3.misses === 3, `时效限定（timeRange）不读缓存（misses=${stats3.misses}）`);
  ok(d.results.length > 0, "时效限定搜索仍有结果");
  console.log(fail.length ? "cache: FAIL" : "cache: PASS");
  return fail.length === 0;
}

/* ---------- 模式 6：分享链接 + 持久化恢复 ---------- */

async function verifyShare() {
  const fail = [];
  const ok = (cond, msg) => (cond ? console.log("  ✓", msg) : (fail.push("✗ " + msg), console.log("  ✗", msg)));

  const { saveSession, loadSession } = await importAbs(
    path.join(ROOT, "server/research/persistence.js"),
  );
  const { ResearchSession } = await importAbs(path.join(ROOT, "server/research/session.js"));

  console.log("1) 开一个 mock strict 会话并等完成");
  const r = await startSession({
    question: "上海近十年常住人口变化与背后原因",
    mode: "strict",
    mock: true,
  });
  const evts = [];
  await subscribeSSE(
    `${BASE}/api/research/stream/${r.id}`,
    (ev) => evts.push(ev),
    (ev) => ev.type === "done" || ev.type === "error",
  );
  const evidence = evts.filter((e) => e.type === "evidence");
  ok(evidence.length === 5, `会话完成，证据 5 条（实际 ${evidence.length}）`);

  console.log("2) 从磁盘重建（loadSession）");
  const rebuilt = loadSession(r.id);
  ok(!!rebuilt, "loadSession 返回会话");
  if (rebuilt) {
    ok(
      Math.abs((rebuilt._events?.length || 0) - evts.length) <= 2,
      `事件日志完整（磁盘 ${rebuilt._events?.length} vs 客户端 ${evts.length}）`,
    );
    ok(rebuilt.evidence.length === 5 && rebuilt.qa?.length === 0, "状态字段完整");
  }

  console.log("3) 服务器未见过但磁盘存在的 id → 路由自动恢复");
  const ghost = new ResearchSession({ question: "磁盘恢复测试", mode: "quick", mock: true });
  ghost.phase = "done";
  ghost.evidence.push({
    id: "e1", index: 1, url: "https://example.com/a",
    title: "测试来源", quote: "测试引文。", note: "测试。",
    tier: 1, tierLabel: "权威", verified: true, year: 2024,
  });
  ghost.sections.push({
    index: 1, heading: "测试章节", markdown: "正文 [1]。", citations: [], crossVerified: true,
  });
  ghost._events.push({ type: "state", state: ghost.state }, { type: "evidence", ...ghost.evidence[0] });
  ghost.closed = true;
  saveSession(ghost, { immediate: true });
  const stateRes = await fetch(`${BASE}/api/research/${ghost.id}/state`).then((x) => x.json());
  ok(!!stateRes.state && stateRes.state.evidence?.length === 1, `GET /state 走磁盘恢复（${stateRes.error || "ok"}）`);

  console.log("4) 分享链接回放页面（?session=<id>）");
  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--window-size=1600,900"],
    protocolTimeout: 60000,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // 注意：回放页一加载就订阅 SSE，networkidle0 永远不会空闲 —— 用 domcontentloaded
  await page.goto(`${BASE}/research.html?session=${r.id}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForSelector(".ev-card", { timeout: 30000 });
  await sleep(2500);
  const replay = await page.evaluate(() => {
    const b = document.querySelector(".rb-report-body");
    // iter-17：rp-online → 裁决段；rp-section → 认定块
    const ol = document.querySelector(".doc-verdict-text")?.getBoundingClientRect();
    return {
      evidence: document.querySelectorAll(".ev-card").length,
      sections: document.querySelectorAll(".doc-finding").length,
      crossCards: document.querySelectorAll(".tr-challenge.cross").length,
      oneLine: document.querySelector(".rp-online")?.textContent?.slice(0, 40),
      shareBtn: !!document.querySelector(".rb-share-btn"),
      qaItems: document.querySelectorAll(".qa-item").length,
      reportScrollTop: b ? Math.round(b.scrollTop) : null, // iter-14：回放应在顶部（一句结论可见）
      oneLineY: ol ? Math.round(ol.y) : null,
      trajPinned: (() => {
        const l = document.querySelector(".rb-traj-list");
        return l ? l.scrollTop + l.clientHeight >= l.scrollHeight - 64 : null;
      })(),
      timerVal: (document.querySelector(".rb-hstats")?.textContent.match(/\d\d:\d\d/) || [])[0] ?? null,
    };
  });
  console.log("   ", JSON.stringify(replay));
  ok(replay.evidence === 5, `回放页证据 5 张（实际 ${replay.evidence}）`);
  ok(replay.sections === 3, `回放页报告 3 节（实际 ${replay.sections}）`);
  ok(replay.crossCards === 1, "守卫卡回放");
  ok(!!replay.shareBtn, "分享按钮存在");
  ok(replay.reportScrollTop === 0 && replay.oneLineY !== null && replay.oneLineY > 0, `回放定位在报告顶部（scrollTop=${replay.reportScrollTop}，结论 y=${replay.oneLineY}，iter-14）`);
  ok(replay.trajPinned === true, "回放轨迹贴底（iter-14）");
  ok(replay.timerVal && replay.timerVal !== "00:00", `回放显示真实用时（${replay.timerVal}，iter-14）`);

  // iter-15：回放默认进入「报告舞台」，切回全过程后轨迹应贴底且无横向溢出
  const stageOn = await page.evaluate(
    () => document.querySelector(".rb-grid")?.className.includes("rb-grid-stage-report") ?? false,
  );
  ok(stageOn, "回放默认报告舞台（iter-15）");
  await page.click(".rb-stage-switch .ib-seg:last-of-type").catch(() => {});
  await sleep(500);
  const processView = await page.evaluate(() => {
    const l = document.querySelector(".rb-traj-list");
    return {
      trajPinned: l ? l.scrollTop + l.clientHeight >= l.scrollHeight - 64 : null,
      noHOverflow: l ? l.scrollWidth <= l.clientWidth + 2 : null,
      visible: l ? l.clientWidth > 0 : null,
    };
  });
  ok(!!processView.visible && !!processView.trajPinned, "全过程视图轨迹贴底");
  ok(processView.noHOverflow === true, "时间线无横向溢出（URL 型标题不再顶宽，iter-15）");

  console.log("5) 分享链接构造（data-share）");
  // 注意：headless 下真实 Clipboard API 会锁死渲染进程，剪贴板交互留给真实浏览器手动验证；
  // 这里验证链接构造（data-share 属性包含正确的 session id）
  const dataShare = await page
    .evaluate(() => document.querySelector(".rb-share-btn")?.getAttribute("data-share") || "")
    .catch(() => "");
  ok(dataShare.includes(`session=${r.id}`), `分享链接含 session id（${dataShare.slice(0, 60)}…）`);
  try {
    await page.screenshot({ path: path.join(SHOTS, "share-replay.png") });
  } catch (e) {
    console.log("   截图失败（不影响判定）:", e?.message);
  }
  await browser.close();
  ok(errors.length === 0, "回放页无 JS 错误");

  console.log(fail.length ? "share: FAIL" : "share: PASS");
  return fail.length === 0;
}

/* ---------- 调度 ---------- */

const modes = {
  mock: () => verifyMock(arg),
  fire: verifyFire,
  qa: verifyQa,
  ui: verifyUi,
  cache: verifyCache,
  share: verifyShare,
};

if (!modes[mode]) {
  console.log(`未知模式: ${mode}\n可用: ${Object.keys(modes).join(", ")}`);
  process.exit(2);
}

console.log(`目标: ${BASE}（DEMO_BASE 可覆盖）`);
try {
  const ok = await modes[mode]();
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error("验证执行异常:", e?.stack || e);
  process.exit(2);
}
