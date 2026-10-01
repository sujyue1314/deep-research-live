import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// 迭代 worktree 用独立端口对：DEMO_SERVER_PORT 指向后端，vite 用 --port 覆盖
const serverPort = process.env.DEMO_SERVER_PORT || "3001";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
    // 编辑器/工具的原子写入会留下 .*.tmpdir/ 瞬时目录，Windows 上 watch 会 EBUSY 崩溃
    watch: {
      ignored: [
        "**/.git/**",
        "**/node_modules/**",
        "**/.run/**",
        "**/.*.tmpdir/**",
        "**/*.tmp",
      ],
    },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  cacheDir: ".run/.vite-cache", // worktree 独立缓存，不污染主仓库
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      // 多页构建：《大富翁》main + 调查局 research
      input: {
        main: resolve(__dirname, "index.html"),
        research: resolve(__dirname, "research.html"),
      },
    },
  },
});
