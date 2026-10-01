// 报告追问：报告完稿后的 Q&A，答案只能来自本次固定证据
// 复用会话事件总线（qa-* 事件在 closed 后仍可推送），直播观众实时看到问答
import { chatStream } from "../ai/client.js";
import { evidenceBrief } from "./agent.js";

const ANSWER_MAX_TOKENS = 2000;

function sectionsBrief(session) {
  if (!session.sections.length) return "（报告未生成章节）";
  return session.sections
    .map((s) => `## ${s.heading}${s.crossVerified ? "（交叉验证✓）" : ""}\n${s.markdown}`)
    .join("\n\n");
}

const SYS_PROMPT = `你是「现场调查局」的答复员。观众刚看完一场完整调查，现在就证据提问。

【铁律】
- 你只能依据下面给出的【证据清单】与【报告章节】回答；清单之外的信息一律不得凭空补充。
- 回答必须二选一：要么用引用编号 [n] 支撑（n 对应证据编号），要么明确声明「证据不足 / 超出本次调查范围」并说明缺什么证据。
- 不得笼统断言、不得编造数字与年份、不得引用清单之外的来源，不得回答与本次调查无关的问题。

【输出】纯文本中文，直接作答（60-250 字），可含 [n] 引用。不要输出 JSON、不要复述证据清单。`;

/**
 * 机器诚实性复核：答案要么有合法 [n] 引用，要么有明确的证据不足声明
 */
function checkAnswer(text, evidenceCount) {
  if (!text || text.trim().length < 5) return { ok: false, reason: "回答过短或为空" };
  const cited = [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const valid = cited.filter((n) => n >= 1 && n <= evidenceCount);
  if (valid.length) return { ok: true };
  const honest =
    /证据不足|无法(回答|给出|确认)|超出.{0,4}(证据|范围|清单)|未涵盖|没有.{0,6}(数据|证据|记录|涉及)|不在.{0,4}证据|无从/;
  if (honest.test(text)) return { ok: true };
  if (cited.length) {
    return { ok: false, reason: `引用编号超出证据范围（本次仅 ${evidenceCount} 条证据）` };
  }
  return { ok: false, reason: "既未引用任何证据编号，也未声明证据不足" };
}

async function streamAnswer(session, entry, user, nudge) {
  const messages = [
    { role: "system", content: SYS_PROMPT },
    { role: "user", content: user },
  ];
  if (nudge) {
    // 把首轮回答留作上下文，再追加系统纠错；答案文本清空重流
    messages.push(
      { role: "assistant", content: entry.a || "（回答）" },
      { role: "user", content: nudge },
    );
    entry.a = "";
  }
  try {
    await chatStream(
      { messages, temperature: 0.5, maxTokens: ANSWER_MAX_TOKENS },
      (delta, isReasoning) => {
        if (!isReasoning && delta) {
          entry.a += delta;
          session.emit({ type: "qa-chunk", id: entry.id, chunk: delta });
        }
      },
    );
  } catch (e) {
    const msg = `\n（回答失败：${String(e?.message || e).slice(0, 100)}）`;
    entry.a += msg;
    session.emit({ type: "qa-chunk", id: entry.id, chunk: msg });
  }
}

/**
 * 执行一次追问（真实模式）
 */
export async function runFollowup(session, question) {
  const q = String(question || "").trim().slice(0, 300);
  if (!q) throw new Error("question 不能为空");

  const id = `qa${session.qa.length + 1}`;
  const entry = { id, q, a: "", note: null };
  session.qa.push(entry);
  session.emit({ type: "qa-q", id, q });

  const user = `【研究问题】${session.question}

【证据清单】
${evidenceBrief(session)}

【报告已成稿章节】
${sectionsBrief(session)}

【观众追问】${q}`;

  await streamAnswer(session, entry, user);

  // 机器诚实性复核：不合格打回一次
  const verdict = checkAnswer(entry.a, session.evidence.length);
  if (!verdict.ok && !entry.note) {
    entry.note = `系统复核：${verdict.reason}，已要求重答`;
    session.emit({ type: "qa-note", id, text: entry.note });
    await streamAnswer(
      session,
      entry,
      user,
      `【系统】你的上一次回答${verdict.reason}。请严格基于上面的证据清单重答：要么用 [n] 引用具体证据支撑，要么明确说明「证据不足」及缺少什么。不得编造清单之外的信息。`,
    );
  }
  session.emit({ type: "qa-done", id });
}
