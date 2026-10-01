// 长驻服务器（供真实链路测试使用；正式使用走 pnpm dev）
process.env.PORT = process.env.PORT || "3003";
await import("./server/index.js");
