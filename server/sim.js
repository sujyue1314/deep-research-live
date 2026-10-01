// 无头模拟：验证经典大富翁引擎 + AI 编排，自动对局 N 回合
import { GameSession } from "./engine/game.js";
import { standings, spaceAt } from "./engine/world.js";

const ROUNDS = Number(process.argv[2] || 6);
const MODE = process.argv[3] || "spectator"; // 观战模式全自动

const s = new GameSession({ mode: MODE });
s.addSubscriber(); // 模拟里算作有观众，绕过观战挂起
s.on((e) => {
  if (e.type === "log") console.log(`  R${String(e.round).padEnd(2)} ${e.text}`);
  else if (e.type === "phase") console.log(`\n===== 阶段 ${e.phase} · R${e.round} =====`);
  else if (e.type === "text-chunk" && e.channel === "commentary") process.stdout.write(e.chunk);
  else if (e.type === "dice") console.log(`  🎲 ${e.playerId} 掷出 ${e.dice[0]}+${e.dice[1]}${e.doubles ? "（双数）" : ""}`);
});

await s.start();

let waited = 0;
while (!s.state.over && s.state.round < ROUNDS && waited < 240) {
  await new Promise((r) => setTimeout(r, 1500));
  waited++;
}

console.log("\n===== 终局（或模拟截止） =====");
standings(s.state).forEach((p, i) =>
  console.log(`#${i + 1} ${p.name.padEnd(4)} ${p.isBankrupt ? "[破产]" : `${p.assets}万`} 持地 ${p.props} 处`)
);
console.log("棋盘归属：");
s.state.spaces.forEach((sp) => {
  if (sp.owner !== "bank") {
    const p = s.state.players.find((x) => x.id === sp.owner);
    console.log(`  ${sp.name.padEnd(6)} → ${p?.name} ${["空地", "房", "酒店"][sp.building]}`);
  }
});
process.exit(0);
