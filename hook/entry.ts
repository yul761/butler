import { main, readStdin } from "./butler-hook";
import { realCheckDeps, runCheck, runPushCheck } from "./check";
import { realGateDeps, runGate } from "./gate";

// 设计文档 4.3：任何异常都以退出码 0 静默结束，绝不阻塞 Claude Code。
process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));

/** 跑一个会回答 Claude Code 的模式：等写完再退出，管道上的输出才不会被截断。 */
async function answer(run: (stdin: string) => Promise<string>): Promise<void> {
  let out = "";
  try {
    out = await run(await readStdin());
  } catch {
    out = "";
  }
  if (out) await new Promise<void>((resolve) => process.stdout.write(out, () => resolve()));
}

const mode = process.argv[2];
// gate：合并闸门；check：编辑后的确定性检查；check-push：push 前的检查（契约 4.5）；其余照旧写收件箱。
const job =
  mode === "gate"
    ? answer((s) => runGate(s, process.env, realGateDeps))
    : mode === "check"
      ? answer((s) => runCheck(s, process.env, realCheckDeps))
      : mode === "check-push"
        ? answer((s) => runPushCheck(s, process.env, realCheckDeps))
        : main();
void job.finally(() => process.exit(0));
