// 流式 JSON 字段提取器：从逐块到达的 JSON 文本中实时解析出某个字符串字段的值
// 用于把模型输出的 {"thought":"..."} 流实时渲染成可读文本（不显示 JSON 骨架）

const DECODE: Record<string, string> = {
  n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f",
};

export class JsonFieldReader {
  private buffer = "";
  private state: "searching" | "reading" | "done" = "searching";
  private holdEscape = false;

  constructor(private field: string) {}

  reset() {
    this.buffer = "";
    this.state = "searching";
    this.holdEscape = false;
  }

  /** 推入一段原始文本，返回本段新解码出的字段内容 */
  push(chunk: string): string {
    if (this.state === "done") return "";
    this.buffer += chunk;
    if (this.state === "searching") {
      const m = this.buffer.match(new RegExp(`"${this.field}"\\s*:\\s*"`));
      if (!m) {
        // 找不到键：保留尾部，防止键跨块到达
        if (this.buffer.length > 256) this.buffer = this.buffer.slice(-80);
        return "";
      }
      this.state = "reading";
      this.buffer = this.buffer.slice(m.index! + m[0].length);
    }
    return this.decodeAvailable();
  }

  private decodeAvailable(): string {
    let out = "";
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch === "\\") {
        if (i + 1 >= this.buffer.length) {
          // 转义符号跨块：保留反斜杠等下一段
          this.holdEscape = true;
          this.buffer = "\\";
          return out;
        }
        const nx = this.buffer[i + 1];
        if (nx === "u") {
          // \uXXXX
          if (i + 6 > this.buffer.length) {
            this.buffer = this.buffer.slice(i);
            this.holdEscape = true;
            return out;
          }
          out += String.fromCharCode(parseInt(this.buffer.slice(i + 2, i + 6), 16));
          i += 5;
        } else {
          out += DECODE[nx] ?? nx;
          i++;
        }
        continue;
      }
      if (ch === '"') {
        this.state = "done";
        this.buffer = "";
        return out;
      }
      out += ch;
    }
    this.buffer = "";
    return out;
  }
}

// 多通道读取器工厂：按 channel 键缓存 JsonFieldReader
export function createReaders() {
  const map: Record<string, JsonFieldReader> = {};
  return {
    get(key: string, field: string): JsonFieldReader {
      if (!map[key]) map[key] = new JsonFieldReader(field);
      return map[key];
    },
    reset(key?: string) {
      if (key) { map[key]?.reset(); }
      else {
        for (const k of Object.keys(map)) map[k].reset();
      }
    },
  };
}
