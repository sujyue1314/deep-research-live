// 会话持久化：全量事件日志落盘 + 重启后按需恢复
// 存储位置 server/research/.data/<id>.json（id 仅允许 rs_xxx 安全字符）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResearchSession } from "./session.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), ".data");
const SAVE_DEBOUNCE_MS = 1500;
const saveTimers = new Map(); // id -> timer（节流批量写）

function safePath(id) {
  if (!/^[\w-]+$/.test(id)) return null; // 防路径穿越
  return path.join(DATA_DIR, `${id}.json`);
}

/**
 * 保存会话（默认 1.5s 节流合并突发事件；done/qa-done 等关键点立即写）
 */
export function saveSession(session, { immediate = false } = {}) {
  if (!session?.id) return;
  const file = safePath(session.id);
  if (!file) return;
  const doSave = () => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(session.toJSON()), "utf-8");
    } catch (e) {
      console.warn(`[research.persistence] 保存 ${session.id} 失败: ${String(e?.message || e)}`);
    }
  };
  if (immediate) {
    const t = saveTimers.get(session.id);
    if (t) clearTimeout(t);
    saveTimers.delete(session.id);
    doSave();
    return;
  }
  if (saveTimers.has(session.id)) return;
  saveTimers.set(
    session.id,
    setTimeout(() => {
      saveTimers.delete(session.id);
      doSave();
    }, SAVE_DEBOUNCE_MS),
  );
}

/**
 * 从磁盘恢复会话（不含校验上下文：仅供回放与追问）
 */
export function loadSession(id) {
  const file = safePath(id);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return ResearchSession.fromJSON(data);
  } catch (e) {
    console.warn(`[research.persistence] 读取 ${id} 失败: ${String(e?.message || e)}`);
    return null;
  }
}
