// 调查局前端 API：REST 操作 + SSE 事件流
export interface REvent {
  type: string;
  [key: string]: any;
}

export async function startResearch(
  question: string,
  opts: { mode?: string; mock?: boolean } = {},
) {
  const r = await fetch("/api/research/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, ...opts }),
  });
  return r.json();
}

export async function stopResearch(id: string) {
  await fetch(`/api/research/${id}/stop`, { method: "POST" });
}

// 报告追问（报告完稿后解锁；答案走同一条 SSE 事件流的 qa-* 事件）
export async function askResearch(id: string, question: string) {
  const r = await fetch(`/api/research/${id}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  return r.json();
}

export async function researchInfo() {
  const r = await fetch("/api/research/info");
  return r.json() as Promise<{ hasKey: boolean; model: string }>;
}

export function subscribeResearch(id: string, onEvent: (e: REvent) => void): () => void {
  const es = new EventSource(`/api/research/stream/${id}`);
  es.addEventListener("message", (ev) => {
    try {
      onEvent(JSON.parse((ev as MessageEvent).data));
    } catch {}
  });
  es.onerror = () => {
    // 浏览器会自动重连；历史事件由服务端回放，断线不丢内容
  };
  return () => es.close();
}

// 预设研究问题（展会常见、可验证的开放问题）
export const PRESETS = [
  "上海近十年常住人口变化与背后原因",
  "2024 年诺贝尔奖各奖项得主及其研究贡献",
  "比较 2024-2025 主流国产大模型的特点与代表应用",
  "2025 年全球电动车销量前三企业及冠军车型",
  "近期值得关注的的开源编程助手项目",
  "每天喝咖啡对健康的影响：现有证据怎么说",
];
