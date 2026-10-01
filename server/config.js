// 模型端点配置：从 DSH 凭证文件 / 环境变量读取 Atria 密钥
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const MODEL = process.env.ATRIA_MODEL || "Atria-Dawn-Preview";
export const BASE_URL =
  process.env.ATRIA_BASE_URL || "https://discovery-api.intern-ai.org.cn/v1";
export const PORT = Number(process.env.PORT || 3001);

const credPaths = [
  process.env.ATRIA_CREDENTIALS,
  path.join(os.homedir(), ".dsh", ".credentials.yaml"),
  path.join(os.homedir(), ".dsh", "credentials.yaml"),
];

export function loadApiKey() {
  for (const p of credPaths) {
    if (!p || !fs.existsSync(p)) continue;
    try {
      const yaml = fs.readFileSync(p, "utf8");
      const m = yaml.match(/ATRIA_API_KEY:\s*(\S+)/);
      if (m && m[1]) return m[1].trim();
    } catch {}
  }
  if (process.env.ATRIA_KEY) return process.env.ATRIA_KEY;
  return null;
}

export const API_KEY = loadApiKey();
