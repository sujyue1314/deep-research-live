# 探照灯 · Atria Dawn Preview 深度研究 Demo

用于展会现场展示 Atria-Dawn-Preview 的 Agentic 深度研究能力。
入口：`http://127.0.0.1:5180/research.html`（开发）或 `http://127.0.0.1:3001/research.html`（生产构建）。
基于 Node 服务端（`server/index.js`）。

## 它展示了什么

- **Discovery 维度**：实时联网搜索 → 阅读网页取证 → 固定证据卡片 → 发现并裁决来源冲突 → 撰写带引用的报告
- **全程可视化**：左侧直播 Agent 的思考流（逐字打出），中央证据卡按参考文献表陈列（冲突另设「分歧」提示块），右侧第一性要素 + 计划树 + 报告逐段生成
- **可验证性**：报告里每个 `[n]` 引用可点击，定位到证据卡并可打开原始来源 URL
- **视觉**：Anthropic 式编辑/海报风格——暖纸底色、陶土橙强调、衬线大标题、发丝线分隔

## 三种模式

| 模式 | 流程 | 适用 |
|---|---|---|
| 快查 | 单智能体，5 分钟预算 | 展会常规轮转 |
| 深度 | 单智能体，12 分钟预算 | 完整题目深挖 |
| 严格·多智能体 | 调查员取证 → 质疑者挑战 → 调查员答辩 → 裁决者写报告 | 展示多智能体辩论与裁决 |

## 信息准确性体系

**机器强制层（服务端硬校验，模型无法绕过）：**
- 引文核验：`save_evidence` 的 quote 必须能在来源上下文（正文/搜索摘要）中逐字匹配，否则拒收
- 引用编号校验：`write_section` 的 `[n]` 必须对应已固定证据，越界整节打回/丢弃
- URL 溯源：所有引用 URL 必须来自搜索/读取结果
- 交叉验证：按主域名计算独立来源数，单一来源的章节自动降置信度
- **交叉验证守卫（源多样性主动补搜）**：证据 ≥2 条且全部来自同一域名时系统确定性告警——
  strict 模式下质疑者必须给出异源检索词，系统自动执行补搜（首次无新域名时自动
  `exclude_domains` 排除已知域名重试）；quick/deep 模式在 finish 前一次性拦截并批准
  额外检索预算。补搜成功则异源证据入池、置信度可跨域名升级；失败则诚实维持「中」，
  绝不伪造交叉验证

**启发式辅助层：**
- 来源分级徽章：权威 / 一般 / 存疑（URL 域名 + 标题规则）
- 时效徽章：从标题/引文抽取年份
- 置信度标注：裁决者对每节给出 高/中/低，机器复核「高置信但无独立来源」会降级

**多智能体辩论（严格模式）：**
- 质疑者审查证据清单，提出 1-4 条挑战，可触发追加搜索；单一域名风险下必须输出异源检索词
- 调查员针对质疑答辩（可补证，含系统守卫要求的异源交叉证据）
- 裁决者裁决冲突、按置信度撰写报告（含口径与不确定性声明），可看到系统统计的域名分布

**第一性要素**：任何模式下 `update_plan` 都必须先列出第一性要素（不可再分的事实基础与权威口径），显示在右栏面板中。

## 架构

```
research.html ── src/research/           （React + Vite 独立入口）
                    ├ App.tsx            事件流中枢（SSE → UI 状态）
                    ├ api.ts             REST + EventSource
                    ├ components/        Header/InputBar/PlanTree/PrinciplesPanel/
                    │                    TrajectoryStream（多智能体头像）/EvidenceBoard/ReportView
                    └ styles.css         编辑/海报主题

server/research/  （挂在 server/index.js 上）
                    ├ router.js          /api/research/* 路由 + SSE 回放
                    ├ session.js         会话状态 + 事件总线 + 预算限制（quick/deep/strict）
                    ├ agent.js           JSON 协议循环 + 三阶段流水线 + 机器强制校验
                    ├ verify.js          引文核验 / 来源分级 / 年份 / 独立来源计数
                    ├ tools.js           搜索 + 网页正文抓取（SSRF 防护）
                    └ mock.js            离线演练轨迹（quick/deep + strict 守卫辩论尾段）
```

Agent 协议：模型每步输出 `{"thought": "...", "action": {"tool": "...", ...}}`，
`thought` 原始 JSON 流逐块转发到前端（复用 `src/json-reader.ts` 实时提取渲染），
`action` 由服务端执行（7 种工具：update_plan / web_search / open_page /
save_evidence / note_conflict / write_section / finish），观测结果回灌模型继续循环。

## 运行

### 1. 配置 Atria 密钥

密钥配置（见 `server/config.js`）：

- 文件：`~/.dsh/.credentials.yaml` 中写入 `ATRIA_API_KEY: sk-xxx`（优先）
- 或环境变量：`ATRIA_KEY` / `ATRIA_API_KEY`
- 端点：默认国内 `https://discovery-api.intern-ai.org.cn/v1`，可用 `ATRIA_BASE_URL` 覆盖

**没有密钥也能跑**：服务端自动切换到「演练模式」，回放一条预制调查轨迹
（上海近十年常住人口变化），可在界面的「演练模式」勾选框手动强制开启。

### 2. 启动

```bash
pnpm dev          # 同时起服务端(3001) + Vite(5180)
# 或生产构建：
pnpm build && pnpm start   # 服务端直接伺服 dist/，访问 :3001/research.html
```

### 3. 搜索来源配置（可选）

`web_search` 工具的提供者优先级：

1. `TAVILY_API_KEY`（推荐，agent 友好）
2. `SERPER_API_KEY`
3. DuckDuckGo HTML 兜底（无需密钥）
4. Bing HTML 兜底（无需密钥）

## 展会运维

- **模式**：快查 / 深度 / 严格（多智能体），上限在 `server/research/session.js` 的 `MODES`
- **断线重连**：SSE 历史事件全量回放，刷新页面不丢调查进度
- **断网兜底**：无密钥或勾选「演练模式」自动回放预制轨迹（严格模式含完整辩论尾段）
- **服务端容错**：SSE 管道错误隔离 + uncaughtException/unhandledRejection 安全网，浏览器断开不会拖垮服务器
- **停止**：顶栏「停止调查」随时收尾；超时自动收尾

## 开发验证

回归套件统一入口（默认打 5180 主预览，`DEMO_BASE` 环境变量可指向任一 worktree 的端口对）：

```bash
node scripts/verify.mjs mock          # 离线 mock 轨迹断言（strict + quick，不消耗 API）
node scripts/verify.mjs fire          # 交叉验证守卫手术式测试（真实模型 + 真实 Tavily）
node scripts/verify.mjs qa            # 报告追问手术式测试（范围内引用 / 范围外诚实拒答）
node scripts/verify.mjs ui            # puppeteer 全流程回归（守卫卡+双向联动+打印+追问）
node scripts/verify.mjs cache         # 搜索缓存单元测试（命中/一致性/异源补搜不读缓存）
```

- `mock` / `ui` 无需 API 密钥（演练模式），适合 CI
- `fire` / `qa` / `cache` 需要 `TAVILY_API_KEY`（和真实模型密钥）
- `ui` 模式需要本机 Chrome；截图与日志输出到 `.shots/`
- npm 脚本等价：`pnpm run verify` / `pnpm run verify:ui`（若 pnpm 版本触发依赖策略检查，直接用上面的 node 调用）

## 迭代开发（worktree 约定）

每次优化一个独立 worktree，互不干扰、可并行对比：
```bash
git worktree add .wt/iter-N -b iter/N-主题    # 建迭代分支
# 端口对约定：iter-1 = 5210 前端 + 3110 后端，iter-2 = 5220 + 3120 ……
# 后端：PORT=31N0 DEMO_SERVER_PORT=31N0 TAVILY_API_KEY=… node server/index.js
# 前端：DEMO_SERVER_PORT=31N0 node node_modules/vite/bin/vite.js --port 52N0
```

- 主仓库 `main` 始终是稳定基线（即 `pnpm dev` 的 5180/3001 预览源）
- worktree 的 `node_modules` 用 junction 共享主仓库的安装（避免 pnpm 供应链策略
  最小发布年龄检查与重复安装）；依赖变化时再单独处理
- 验证链：`node scripts/verify.mjs <mode>`（见上节）→ 真实模式跑通
- 通过后合并回 main；迭代目录 `.wt/`、运行产物 `.run/` 均不入库
- 故障提示：UI 行为异常或验证莫名失败时，先怀疑 vite 监听陈旧（编辑未生效），
  重启该 worktree 的 vite 进程后重试

## 已知限制

- 模型为纯文本输入，本 Demo 的输入只有文字；所有视觉效果由 UI 层从结构化事件渲染
- 纯前端 markdown 子集渲染（列表/加粗/引用条），不支持表格等复杂语法
- quick 模式步数紧张时可能只写 1 节报告（真实测试：26 步 / 1 节），用「深度」模式获得完整报告
