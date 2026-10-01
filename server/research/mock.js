// 离线演练模式：无 API 密钥 / 断网时回放一条预制调查轨迹
// 事件协议与 agent.js 完全一致，前端无感知
// quick/deep：核心取证 → 报告收尾；strict：核心取证 → 质疑 → 答辩 → 裁决

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 按 2-6 字的随机块流式输出，模拟模型逐 token 生成
function streamThought(session, stepNo, thought, actionName, voice = "investigator") {
  session.stats.steps = stepNo;
  session.emit({ type: "step", n: stepNo, voice });
  const raw =
    JSON.stringify({ thought, action: { tool: actionName ?? "tool" } }).slice(0, -2) +
    " intended}";
  let i = 0;
  while (i < raw.length) {
    const size = 2 + Math.floor(Math.random() * 5);
    session.emit({ type: "text-chunk", chunk: raw.slice(i, i + size) });
    i += size;
  }
  session.emit({ type: "text-done" });
}

async function writeMockSection(s, index, heading, bullets, confidence, crossVerified) {
  const markdown = heading + "\n\n" + bullets.map((b, i) => `${i + 1}. ${b}`).join("\n");
  s.sections.push({ index, heading, markdown, citations: [], crossVerified });
  s.emit({ type: "section", index, heading, confidence, crossVerified });
  // 大屏打字机效果
  let i = 0;
  while (i < markdown.length) {
    const size = 30;
    s.emit({ type: "section-chunk", index, chunk: markdown.slice(i, i + size) });
    i += size;
    await sleep(50);
  }
  await sleep(600);
}

export async function runMockResearch(session) {
  session.phase = "running";
  session.emit({ type: "state", state: session.state });
  try {
    let i = 0;
    for (const t of CORE_STEPS) {
      if (session.aborted) {
        session.aborted = false;
        return finishMock(session);
      }
      await runEntry(session, ++i, t);
    }
    if (session.mode === "strict") {
      for (const t of STRICT_TAIL) {
        if (session.aborted) {
          session.aborted = false;
          return finishMock(session);
        }
        await runEntry(session, ++i, t);
      }
    } else {
      for (const t of QUICK_TAIL) {
        if (session.aborted) {
          session.aborted = false;
          return finishMock(session);
        }
        await runEntry(session, ++i, t);
      }
    }
    finishMock(session);
  } catch (e) {
    session.emit({ type: "error", message: String(e?.message || e) });
    session.finish("error");
  }
}

async function runEntry(session, stepNo, entry) {
  streamThought(session, stepNo, entry.thought, entry.action, entry.voice);
  await sleep(400);
  await entry.run(session);
}

function finishMock(session) {
  if (!session.oneLine) {
    session.oneLine = "演练数据：调查模拟完成。";
    session.emit({ type: "one-line", text: session.oneLine });
  }
  session.emit({ type: "stats", stats: session.stats });
  session.finish("done");
}

export const MOCK_QUESTION = "上海近十年常住人口变化与背后原因";

/* ---------- 公共核心：取证 ---------- */

const CORE_STEPS = [
  {
    thought:
      "问题有两个关键点：上海人口的「总量变化」与「背后原因」。先立第一性要素：口径必须是统计公报的「常住人口」（含户籍与非户籍），时点以年度公报的上年末为准，权威序列是统计局公报优先。然后拆成四个子问题逐步查证。",
    action: "update_plan",
    run: async (s) => {
      s.principles = [
        "口径先行：以统计公报「常住人口」为准（含户籍与非户籍常住），区别于户籍人口数字",
        "时点明确：年度公报发布的是上年末快报数据，普查年以普查口径修正",
        "权威序列：统计局公报 > 官方媒体转述 > 聚合/自媒体平台",
      ];
      s.emit({ type: "principles", items: s.principles });
      s.plan = [
        { id: "p0", text: "近十年常住人口总量曲线（2014-2024）", status: "pending" },
        { id: "p1", text: "户籍人口与外来人口的结构变化", status: "pending" },
        { id: "p2", text: "2023-2024 的拐点与短期波动", status: "pending" },
        { id: "p3", text: "人口变化的驱动因素与政策", status: "pending" },
      ];
      s.emit({ type: "plan", items: s.plan });
      await sleep(900);
    },
  },
  {
    thought:
      "先查总量数据。统计公报是最权威的一手来源，我先搜「上海 常住人口 2024 统计公报」。",
    action: "web_search",
    run: async (s) => {
      const query = "上海 常住人口 2024 统计公报";
      s.stats.searches += 1;
      s.plan[0].status = "active";
      s.emit({ type: "plan", items: s.plan });
      s.emit({ type: "search", query, n: s.stats.searches });
      await sleep(1400);
      const results = [
        {
          title: "2024年上海市国民经济和社会发展统计公报",
          url: "https://tjj.sh.gov.com/tjgb/20250329/abc123.html",
          snippet: "至2024年末，全市常住人口2480.5万人，比上年减少7.0万人。",
        },
        {
          title: "上海市概况 - 上海市人民政府",
          url: "https://www.shanghai.gov.cn/nw12344/index.html",
          snippet: "上海是中国人口最多的城市之一，常住人口约2480万。",
        },
        {
          title: "2023年上海市国民经济和社会发展统计公报",
          url: "https://tjj.sh.gov.com/tjgb/20240320/def456.html",
          snippet: "至2023年末，全市常住人口2487.45万人，比上年增加11.5万人。",
        },
        {
          title: "上海人口 - 维基百科",
          url: "https://zh.wikipedia.org/wiki/上海市人口",
          snippet: "上海市常住人口在2014年突破2400万，2023年达到峰值后略有回落。",
        },
      ];
      results.forEach((r) => {
        s.noteKnown(r.url);
        s.noteContext(r.url, `${r.title} ${r.snippet}`);
      });
      s.emit({ type: "search-results", query, results, provider: "mock" });
      await sleep(900);
    },
  },
  {
    thought:
      "最新公报提到 2024 年反减少了 7 万人——这是个重要拐点。我打开 2024 年公报核实原文。",
    action: "open_page",
    run: async (s) => {
      const url = "https://tjj.sh.gov.com/tjgb/20250329/abc123.html";
      s.stats.pages += 1;
      s.emit({ type: "page-open", url, n: s.stats.pages });
      await sleep(1800);
      s.emit({
        type: "page-read",
        url,
        title: "2024年上海市国民经济和社会发展统计公报 - 上海市统计局",
        chars: 3120,
        snippet:
          "至2024年末，全市常住人口2480.5万人，比上年减少7.0万人。其中，户籍常住人口1480.2万人，外来常住人口1000.3万人……全年全市GDP增长5.0%。",
      });
      s.cachePage(url, {
        title: "2024年上海市国民经济和社会发展统计公报",
        text: "至2024年末，全市常住人口2480.5万人，比上年减少7.0万人。其中，户籍常住人口1480.2万人，外来常住人口1000.3万人。",
      });
      await sleep(700);
    },
  },
  {
    thought: "把 2024 年的总量数字固定为第一号证据，引文逐字摘自公报原文。",
    action: "save_evidence",
    run: async (s) => {
      const url = "https://tjj.sh.gov.com/tjgb/20250329/abc123.html";
      const item = {
        id: "e1",
        index: 1,
        url,
        title: "2024年上海市国民经济和社会发展统计公报",
        quote: "至2024年末，全市常住人口2480.5万人，比上年减少7.0万人。",
        note: "官方总量数据：2024 年首次出现小幅净流出（-7.0 万）。",
        tier: 1,
        tierLabel: "权威",
        verified: true,
        year: 2024,
      };
      pushEvidence(s, item, 0);
      await sleep(900);
    },
  },
  {
    thought:
      "总量清楚了，接着查结构。户籍和非户籍人口的走势不同，这往往是理解「总量下降」的关键。",
    action: "web_search",
    run: async (s) => {
      const query = "上海 户籍人口 外来常住人口 结构 变化";
      s.stats.searches += 1;
      s.plan[1].status = "active";
      s.emit({ type: "plan", items: s.plan });
      s.emit({ type: "search", query, n: s.stats.searches });
      await sleep(1300);
      const results = [
        {
          title: "上海户籍人口连年增长，外来人口回落 - 第一财经",
          url: "https://www.yicai.com/news/102345678.html",
          snippet:
            "2024年上海户籍人口达1480.2万，较2014年增加约160万；外来常住人口则从超过千万的峰值回落。",
        },
        {
          title: "上海「抢人」政策观察 - 澎湃新闻",
          url: "https://www.thepaper.cn/newsDetail_forward_10234567",
          snippet: "近年上海持续放宽高校应届毕业生直接落户、居转户年限，户籍人口机械增长明显。",
        },
        {
          title: "上海市人口 - 维基百科",
          url: "https://zh.wikipedia.org/wiki/上海市人口",
          snippet: "2014年全市常住人口2426万，十年间增长约55万后于2023年见顶。",
        },
      ];
      results.forEach((r) => {
        s.noteKnown(r.url);
        s.noteContext(r.url, `${r.title} ${r.snippet}`);
      });
      s.emit({ type: "search-results", query, results, provider: "mock" });
      await sleep(900);
    },
  },
  {
    thought: "第一财经这篇把两条曲线放在一起讲，正是我需要的结构视角。固定为二号证据。",
    action: "save_evidence",
    run: async (s) => {
      const url = "https://www.yicai.com/news/102345678.html";
      const item = {
        id: "e2",
        index: 2,
        url,
        title: "上海户籍人口连年增长，外来人口回落 - 第一财经",
        quote: "2024年户籍人口达1480.2万，较2014年增约160万；外来常住人口从千万峰值回落。",
        note: "结构证据：总量下降主要由外来人口回落贡献，户籍人口仍在增长。",
        tier: 1,
        tierLabel: "权威",
        verified: true,
        year: 2024,
      };
      pushEvidence(s, item, 1);
      await sleep(900);
    },
  },
  {
    thought: "2023 年的公报是冲突的另一方，我把它也固定成证据，一会儿好做逐条对比。",
    action: "open_page",
    run: async (s) => {
      const url = "https://tjj.sh.gov.com/tjgb/20240320/def456.html";
      s.stats.pages += 1;
      s.emit({ type: "page-open", url, n: s.stats.pages });
      await sleep(1400);
      s.emit({
        type: "page-read",
        url,
        title: "2023年上海市国民经济和社会发展统计公报 - 上海市统计局",
        chars: 3260,
        snippet:
          "至2023年末，全市常住人口2487.45万人，比上年增加11.5万人。其中，户籍常住人口1469.1万人，外来常住人口1018.3万人。",
      });
      s.cachePage(url, {
        title: "2023年上海市国民经济和社会发展统计公报",
        text: "至2023年末，全市常住人口2487.45万人，比上年增加11.5万人。",
      });
      await sleep(600);
    },
  },
  {
    thought: "先把 2023 年的总量数据固定为三号证据。",
    action: "save_evidence",
    run: async (s) => {
      const url = "https://tjj.sh.gov.com/tjgb/20240320/def456.html";
      const item = {
        id: "e3",
        index: 3,
        url,
        title: "2023年上海市国民经济和社会发展统计公报",
        quote: "至2023年末，全市常住人口2487.45万人，比上年增加11.5万人。",
        note: "对照数据：2023 年总量仍在增长（+11.5 万），处于十年峰值。",
        tier: 1,
        tierLabel: "权威",
        verified: true,
        year: 2023,
      };
      pushEvidence(s, item, 2);
      await sleep(800);
    },
  },
  {
    thought:
      "等等，这里有个矛盾：2023 年公报说当年还增加了 11.5 万，2024 年却减少 7 万。我找到了两份来源对拐点的不同解读，必须标记冲突并裁决。",
    action: "note_conflict",
    run: async (s) => {
      const urls = [
        "https://tjj.sh.gov.com/tjgb/20250329/abc123.html",
        "https://tjj.sh.gov.com/tjgb/20240320/def456.html",
      ];
      s.conflicts.push({
        id: "c1",
        urls,
        description:
          "2023 年总量仍增 11.5 万，2024 年转为 -7.0 万；对「趋势性下降」还是「短期波动」存在不同解读。",
      });
      s.emit({ type: "conflict", id: 1, urls, description: s.conflicts[0].description });
      await sleep(1400);
    },
  },
  {
    thought:
      "裁决冲突：两份公报本身并不矛盾——连续两年相加仍是历史高位。真正分歧在「原因」上，我再查一篇关于驱动因素的分析。",
    action: "web_search",
    run: async (s) => {
      const query = "上海 常住人口 下降 原因 2024";
      s.stats.searches += 1;
      s.plan[2].status = "active";
      s.emit({ type: "plan", items: s.plan });
      s.emit({ type: "search", query, n: s.stats.searches });
      await sleep(1300);
      const results = [
        {
          title: "上海人口为何出现负增长？专家解读 - 新华网",
          url: "https://www.news.cn/20250401/shanghai-population.html",
          snippet: "生活成本、产业转移与长三角城市群分流是三大主因，同时落户政策对冲了部分流出。",
        },
        {
          title: "长三角人口再分布 - 21世纪经济报道",
          url: "https://www.21jingji.com/article/20250405/xyz.html",
          snippet: "2024年浙江、江苏多座城市人口净流入上升，长三角内部「近沪流动」明显。",
        },
      ];
      results.forEach((r) => {
        s.noteKnown(r.url);
        s.noteContext(r.url, `${r.title} ${r.snippet}`);
      });
      s.emit({ type: "search-results", query, results, provider: "mock" });
      await sleep(900);
    },
  },
  {
    thought: "新华网这篇同时给出了原因与政策视角，作为四号证据，覆盖「驱动因素」这个子问题。",
    action: "save_evidence",
    run: async (s) => {
      const url = "https://www.news.cn/20250401/shanghai-population.html";
      const item = {
        id: "e4",
        index: 4,
        url,
        title: "上海人口为何出现负增长？专家解读 - 新华网",
        quote: "生活成本、产业转移与长三角城市群分流是三大主因，落户政策对冲了部分流出。",
        note: "归因证据：解释了 -7.0 万是成本、产业转移与城市间分流的叠加。",
        tier: 1,
        tierLabel: "权威",
        verified: true,
        year: 2025,
      };
      pushEvidence(s, item, 3);
      await sleep(900);
    },
  },
];

function pushEvidence(session, item, planIdx) {
  session.evidence.push(item);
  if (planIdx != null && session.plan[planIdx]) {
    session.plan[planIdx].status = "done";
    session.emit({ type: "plan", items: session.plan });
  }
  session.emit({ type: "evidence", ...item });
}

/* ---------- 单智能体收尾（quick / deep） ---------- */

const QUICK_TAIL = [
  {
    thought: "证据链完整了：总量、结构、冲突裁决、归因都齐活。开始写报告第一节——背景速览。",
    action: "write_section",
    run: async (s) =>
      writeMockSection(s, 1, "十年总量曲线：从 2400 万到见顶回落", [
        "2014 年上海常住人口约 2426 万，到 2023 年攀升至 2487.45 万，十年增量约 60 万 [1][3]。",
        "2024 年回落至 2480.5 万，净减少 7.0 万人，为近十年首次年度净流出 [1]。",
        "总量变化幅度小（约 0.3%），但标志着一个阶段的转向 [2]。",
      ], "高", true),
  },
  {
    thought:
      "第二节是核心发现——户籍与外来人口「一升一降」的结构分化，以及冲突的裁决。",
    action: "write_section",
    run: async (s) =>
      writeMockSection(s, 2, "结构分化：户籍增、外来降", [
        "户籍人口较 2014 年增加约 160 万至 1480.2 万，主要受落户政策放宽驱动 [2]。",
        "外来常住人口从超千万峰值回落，是总量转负的直接原因 [2]。",
        "关于 2024 年的 -7.0 万：两份公报数据本身自洽（2023 增、2024 减），分歧在归因；生活成本、产业转移与长三角分流是其主因 [1][3]。",
      ], "高", true),
  },
  {
    thought: "最后写结论一节，给出一句话总结并收尾。",
    action: "write_section",
    run: async (s) =>
      writeMockSection(s, 3, "结论：结构性放缓而非整体收缩", [
        "上海人口并未「收缩」，而是从高速集聚转向结构性再平衡 [2][4]。",
        "短期内落户政策仍将支撑户籍人口增长，外来人口走势取决于成本与区域竞争 [4]。",
      ], "中", true),
  },
  {
    thought: "报告写完，用一句话总结今天的调查结论。",
    action: "finish",
    run: async (s) => {
      s.oneLine =
        "上海十年人口从 2426 万增至 2487 万后于 2024 年微降 7 万：增长的主体正在从外来集聚转向政策驱动的户籍增长。";
      s.emit({ type: "one-line", text: s.oneLine });
      await sleep(800);
    },
  },
];

/* ---------- 严格模式辩论尾段（strict） ---------- */

const STRICT_TAIL = [
  {
    thought:
      "证据结构清晰，总量来自统计公报、归因有新华社背书。但有两处弱点：第一，「户籍增长源于落户政策」的因果链只有第一财经一家在说；第二，所有结论都只讨论了常住人口口径，没核验内部一致性。我把最致命的两条挑出来。",
    action: "challenge",
    voice: "skeptic",
    run: async (s) => {
      s.emit({
        type: "challenge",
        id: 1,
        text: "证据 #2 把户籍增长归因于落户政策放宽，但该报道未给出政策量化依据——单一来源的因果归因不能支撑「高置信」。",
        hasSearch: true,
      });
      await sleep(700);
      s.emit({
        type: "challenge",
        id: 2,
        text: "证据 #1 与 #3 均为总量数据且口径一致，但报告若要下「结构性放缓」结论，还需确认户籍/外来两分项的加和与总量一致。",
        hasSearch: false,
      });
      await sleep(900);
      // 第一条挑战触发追加搜索
      const query = "上海 落户政策 应届毕业生 户籍人口 2024";
      s.stats.searches += 1;
      s.emit({ type: "search", query, n: s.stats.searches, voice: "skeptic" });
      await sleep(1300);
      const results = [
        {
          title: "上海应届毕业生直接落户政策 - 上海市人社局",
          url: "https://rsj.sh.gov.com/lhzc/2024/index.html",
          snippet: "2024年新增应届毕业生直接落户高校名单进一步扩围，居转户年限要求持续优化。",
        },
        {
          title: "户籍人口机械增长解读 - 新华网",
          url: "https://www.news.cn/20250301/huji.html",
          snippet: "落户政策优化推动户籍人口机械增长，成为对冲外来人口回落的主要力量。",
        },
      ];
      results.forEach((r) => {
        s.noteKnown(r.url);
        s.noteContext(r.url, `${r.title} ${r.snippet}`);
      });
      s.emit({ type: "search-results", query, results, provider: "mock", voice: "skeptic" });
      await sleep(800);
    },
  },
  {
    thought:
      "质疑者第一条站得住：政策归因此前只有单一来源。追加搜索补上了上海人社局与新华社的佐证——「落户政策推动户籍机械增长」现在是多来源一致结论。第二条只是口径提醒，我会在报告口径声明中明确回应。",
    action: "save_evidence",
    run: async (s) => {
      // 答辩中补一条交叉来源证据
      const url = "https://rsj.sh.gov.com/lhzc/2024/index.html";
      const item = {
        id: "e5",
        index: 5,
        url,
        title: "上海应届毕业生直接落户政策 - 上海市人社局",
        quote: "2024年新增应届毕业生直接落户高校名单进一步扩围，居转户年限要求持续优化。",
        note: "答辩补证：落户政策有官方口径佐证，支撑政策驱动户籍增长的归因。",
        tier: 1,
        tierLabel: "权威",
        verified: true,
        year: 2024,
      };
      pushEvidence(s, item);
      await sleep(800);
    },
  },
  {
    thought:
      "证据、冲突、辩论都齐了。我作为裁决者判三点：冲突上，2023 增与 2024 减并不矛盾，是见顶后的温和回落；置信度上，总量结论有公报+多来源交叉，判「高」；政策归因补证后有多来源支撑，判「高」；对外来人口的短期预测只有专家解读单一视角，判「中」。现在写最终报告。",
    action: "adjudicate",
    voice: "adjudicator",
    run: async (s) => {
      s.emit({
        type: "verdict",
        id: 1,
        text:
          "冲突裁决：2023 年 +11.5 万与 2024 年 -7.0 万出自同一官方统计序列，并非数据矛盾，而是总量见顶后的温和回落；「趋势性下降 vs 短期波动」的分歧在归因层——新华网给出成本、产业转移、长三角分流三要素，无反方证据，采信为当前最佳解释。",
      });
      await sleep(800);
      await writeMockSection(
        s,
        1,
        "口径声明与总量曲线",
        [
          "本报告口径：统计公报「常住人口」（含户籍与非户籍常住），年度公报发布上年末数据 [1][3]。",
          "2014 年约 2426 万，2023 年达 2487.45 万峰值，2024 年回落至 2480.5 万（-7.0 万）[1][3]。",
          "总量十年增量约 60 万，2024 年变动幅度仅 0.3%，属温和回落而非收缩 [2]。",
        ],
        "高",
        true,
      );
      await writeMockSection(
        s,
        2,
        "结构分化与冲突裁决",
        [
          "户籍人口较 2014 年增约 160 万至 1480.2 万；外来常住人口从千万峰值回落，是总量转负的直接因素 [2]。",
          "政策归因经质疑后补证：上海人社局口径确认落户政策持续扩围，与新华社「政策对冲流出」判断一致 [5][4]。",
          "冲突裁决：2023/2024 两份公报数据自洽，「见顶回落」为当前可辩护的共识读法 [1][3]。",
        ],
        "高",
        true,
      );
      await writeMockSection(
        s,
        3,
        "结论与不确定性",
        [
          "上海人口正从外来集聚驱动转向政策驱动的户籍增长，属结构性再平衡 [2][5]。",
          "不确定性：外来人口短期走势仅依赖专家解读视角（单一来源，置信度中），不排除年度波动反复 [4]。",
        ],
        "中",
        true,
      );
      s.oneLine =
        "裁决完成：上海人口总量见顶后温和回落（-7.0 万），增长主体正从外来集聚转向政策驱动的户籍增长；总量结论多来源一致（高置信），短期预测存不确定性（中置信）。";
      s.emit({ type: "one-line", text: s.oneLine });
      await sleep(800);
    },
  },
];
