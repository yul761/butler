import { main, readStdin } from "./butler-hook";
import { realGateDeps, runGate } from "./gate";

// 设计文档 4.3：任何异常都以退出码 0 静默结束，绝不阻塞 Claude Code。
process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));

async function gateMain(): Promise<void> {
  const out = await runGate(await readStdin(), process.env, realGateDeps);
  // 等写完再退出，管道上的输出才不会被截断。
  if (out) await new Promise<void>((resolve) => process.stdout.write(out, () => resolve()));
}

// gate 模式：只在 argv[2] === "gate" 时走闸门，其余照旧。
void (process.argv[2] === "gate" ? gateMain() : main()).finally(() => process.exit(0));
