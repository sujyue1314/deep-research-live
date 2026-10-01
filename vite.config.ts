import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
    // .wt 迭代目录里工具的原子写入会产生 .*.tmpdir/ 瞬时目录，watch 会 EBUSY 崩溃
    watch: {
      ignored: [
        "**/.git/**",
        "**/node_modules/**",
        "**/.wt/**",
        "**/.shots/**",
        "**/.*.tmpdir/**",
        "**/*.tmp",
      ],
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
        ws: true,
      },
    },
  },
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
