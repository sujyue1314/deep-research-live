// 临时验证脚本：puppeteer 无头浏览器跑通「现场调查局」UI（mock 严格模式）
// 服务器在同一进程内启动，避免后台进程被环境清理掉
// 验证完成后删除
process.env.PORT = process.env.PORT || "3003";

import fs from "node:fs";

const SHOTS = "D:\\Demo\\.shots";
fs.mkdirSync(SHOTS, { recursive: true });
const LOG = `${SHOTS}\\verify.log`;
fs.writeFileSync(LOG, "");

// 直接写文件的日志：绕过 stdout 管道缓冲，便于实时定位卡点
const log = (...a) => {
  fs.appendFileSync(LOG, `[${new Date().toISOString().slice(11, 19)}] ${a.join(" ")}\n`);
};
console.log = (...a) => log("console:", ...a);
console.error = (...a) => log("console.error:", ...a);
process.on("uncaughtException", (e) => log("FATAL uncaughtException:", e?.stack || e));
process.on("unhandledRejection", (e) => log("FATAL unhandledRejection:", e?.stack || e));

log("script start");
// 若已有服务器在 3003 运行（本次或上次进程残留），直接复用
let serverOk = false;
try {
  const h = await fetch("http://127.0.0.1:3003/api/research/info");
  serverOk = h.ok;
} catch {}
log(serverOk ? "server already running" : "import server begin");
if (!serverOk) {
  await import("./server/index.js");
  log("import server done");
}

import puppeteer from "puppeteer-core";

const BASE = "http://127.0.0.1:3003";

const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

log("launch chrome");
const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--window-size=1600,900"],
  protocolTimeout: 60000,
});
log("chrome launched");
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console.error: " + m.text());
});

console.log("1) 打开 research.html");
await page.goto(BASE + "/research.html", { waitUntil: "networkidle0", timeout: 30000 });
log("goto done");
await sleep(800);

// 风格探针：确认海报风格令牌真实生效
const styleProbe = await page.evaluate(() => {
  const cs = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el) : null;
  };
  const body = cs("body");
  const title = cs(".rb-title");
  const head = cs(".rb-header");
  const kicker = cs(".rb-kicker");
  const probe = {
    bodyBg: body?.backgroundColor,
    titleFont: title?.fontFamily,
    titleSize: title?.fontSize,
    headBorder: head?.borderBottom,
    kickerColor: kicker?.color,
    kickerSpacing: kicker?.letterSpacing,
  };
  const evNo = document.querySelector(".ev-no");
  const evCard = document.querySelector(".ev-card");
  if (evNo) probe.evNoColor = getComputedStyle(evNo).color;
  if (evCard) {
    const c = getComputedStyle(evCard);
    probe.evCardTransform = c.transform;
    probe.evCardShadow = c.boxShadow;
  }
  const btn = document.querySelector(".rb-btn-primary");
  if (btn) {
    const b = getComputedStyle(btn);
    probe.btnBg = b.backgroundColor;
    probe.btnRadius = b.borderRadius;
  }
  return probe;
});
console.log("   风格探针:", JSON.stringify(styleProbe, null, 2));
await page.screenshot({ path: `${SHOTS}\\01-idle.png` });

console.log("2) 填入预设问题 + 勾选演练模式 + 严格模式 + 开始调查");
await page.click(".ib-chip");
await sleep(300);
const q = await page.$eval(".ib-input", (el) => el.value);
console.log("   输入框内容:", q);
await page.click(".ib-mock input");
// 切到严格（多智能体）模式
await page.click(".ib-mode .ib-seg:last-child");
await page.click(".rb-btn-primary");

console.log("3) 等待计划树出现");
await page.waitForSelector(".pl-item", { timeout: 30000 });
console.log("   计划项数:", await page.$$eval(".pl-item", (els) => els.length));
console.log("   第一性要素:", await page.$$eval(".pr-item", (els) => els.length));

console.log("4) 等待第一条证据卡片");
await page.waitForSelector(".ev-card", { timeout: 90000 });
await sleep(2500);
await page.screenshot({ path: `${SHOTS}\\02-mid.png` });

console.log("5) 思考流文本检查");
const thText = await page.$eval(".tr-th-text", (el) => el.textContent).catch(() => null);
console.log("   最新思路:", (thText || "").slice(0, 60), "...");

console.log("6) 等待冲突、质疑与裁决（严格模式全程约 100s）");
await page.waitForSelector(".tr-conflict", { timeout: 100000 }).catch(() =>
  console.log("   (未检测到冲突事件，继续)"),
);
await page.waitForSelector(".tr-challenge", { timeout: 120000 });
console.log("   质疑块数:", await page.$$eval(".tr-challenge", (els) => els.length));
await page.waitForSelector(".tr-verdict", { timeout: 120000 });
console.log("   裁决块数:", await page.$$eval(".tr-verdict", (els) => els.length));
await page.waitForSelector(".rp-online", { timeout: 150000 });
await sleep(2000);
await page.screenshot({ path: `${SHOTS}\\03-final.png` });

console.log("7) 最终状态检查");
const final = await page.evaluate(() => ({
  evidence: document.querySelectorAll(".ev-card").length,
  tierBadges: document.querySelectorAll(".ev-badge.tier-1").length,
  verifiedBadges: document.querySelectorAll(".ev-verified").length,
  yearBadges: document.querySelectorAll(".ev-year").length,
  principles: document.querySelectorAll(".pr-item").length,
  challenges: document.querySelectorAll(".tr-challenge").length,
  verdicts: document.querySelectorAll(".tr-verdict").length,
  sections: document.querySelectorAll(".rp-section").length,
  confidenceBadges: document.querySelectorAll(".rp-badge").length,
  conflictedCards: document.querySelectorAll(".ev-conflict").length,
  disputeBlocks: document.querySelectorAll(".rb-conflict").length,
  oneLine: document.querySelector(".rp-online span:last-child")?.textContent?.slice(0, 80),
  citations: document.querySelectorAll(".md-cite").length,
  voices: {
    inv: document.querySelectorAll(".tr-voice.v-inv").length,
    skep: document.querySelectorAll(".tr-voice.v-skep").length,
    adj: document.querySelectorAll(".tr-voice.v-adj").length,
  },
}));
console.log("   ", JSON.stringify(final, null, 2));

console.log("页面错误记录:", errors.length ? errors.slice(0, 5) : "无");
await browser.close();
console.log("DONE");
process.exit(0);
