import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// 迭代 worktree 用独立端口对：DEMO_SERVER_PORT 指向后端，vite 用 --port 覆盖
const serverPort = process.env.DEMO_SERVER_PORT || "3001";
const isWorktree = !!process.env.DEMO_SERVER_PORT;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
    // 工具的原子写入会留下 .*.tmpdir/ 瞬时目录，Windows 上 watch 会 EBUSY 崩溃；
    // .wt 迭代目录与 .shots/.run 产物同样无需监听；
    // worktree 另开 usePolling：Windows fsnotify 对「重命名覆盖」类编辑事件会静默丢失
    // （表现为 vite 进程存活但永远服务旧模块），轮询在当前规模树上是零成本且确定性的
    watch: {
      ignored: [
        "**/.git/**",
        "**/node_modules/**",
        "**/.wt/**",
        "**/.run/**",
        "**/.shots/**",
        "**/.*.tmpdir/**",
        "**/*.tmp",
      ],
      ...(isWorktree ? { usePolling: true, interval: 500 } : {}),
    },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  cacheDir: isWorktree ? ".run/.vite-cache" : undefined, // worktree 独立缓存，不污染主仓库
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      // 多页构建：《大富翁》main + 探照灯 research
      input: {
        main: resolve(__dirname, "index.html"),
        research: resolve(__dirname, "research.html"),
      },
    },
  },
});
