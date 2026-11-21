import { inboxDir, main, readStdin, writeEnvelope } from "./butler-hook";
import { parseCheckArgs, realCheckDeps, runCheck, runPushCheck } from "./check";
import { killLiveCommands } from "./check-run";
import { realGateDeps, runGate } from "./gate";
import { writeSync } from "node:fs";
import { runReadonly } from "./readonly";
import { mailboxEnvelope, runMailbox } from "./mailbox";

// 设计文档 4.3：任何异常都以退出码 0 静默结束，绝不阻塞 Claude Code。
// 例外：readonly 模式出错必须拒绝（见 readonlyAnswer），所以这里同步写出 deny 再退出。
const bail = () => {
  if (process.argv[2] === "readonly") {
    try {
      writeSync(1, runReadonly(""));
    } catch {
      // stdout 已不可写：无能为力。
    }
  }
  process.exit(0);
};
process.on("uncaughtException", bail);
process.on("unhandledRejection", bail);
// Claude Code 到点会杀掉 hook：先把还在跑的检查命令（各自的进程组）一起杀掉，别留下孤儿。
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    killLiveCommands();
    process.exit(0);
  });
}

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

/**
 * readonly：分叉讨论的只读保证。
 * 与其他模式「出错就放行」正好相反：分叉是用户要求的只读讨论，宁可错拒，也不能错放，所以读 stdin 失败也写 deny。
 */
async function readonlyAnswer(): Promise<void> {
  let out: string;
  try {
    out = runReadonly(await readStdin());
  } catch {
    out = runReadonly("");
  }
  if (out) await new Promise<void>((resolve) => process.stdout.write(out, () => resolve()));
}

/**
 * mailbox：工具调用的间隙送信箱里的消息（BTL-245）。stdout 写完才把认领的文件记成送出；写不出去就放回去。
 * 最后写一个信封叫主进程马上记账（写不了也不要紧：.done 文件本身就是回执，主进程定时清扫）。
 */
async function mailboxAnswer(): Promise<void> {
  const run = runMailbox(await readStdin(), process.env, process.argv[3] ?? "");
  if (!run.out) return;
  const ok = await new Promise<boolean>((resolve) => process.stdout.write(run.out, (err) => resolve(!err)));
  if (!ok) {
    run.rollback();
    return;
  }
  run.commit();
  try {
    writeEnvelope(inboxDir(process.env), mailboxEnvelope(process.env, Date.now()));
  } catch {
    // 定时清扫会补上。
  }
}

const mode = process.argv[2];
const opts = parseCheckArgs(process.argv.slice(3));
// gate：合并闸门；check：编辑后的确定性检查；check-push：push 前的检查（契约 4.5）；其余照旧写收件箱。
const job =
  mode === "gate"
    ? answer((s) => runGate(s, process.env, realGateDeps))
    : mode === "readonly"
      ? readonlyAnswer()
      : mode === "mailbox"
      ? mailboxAnswer()
      : mode === "check"
      ? answer((s) => runCheck(s, process.env, realCheckDeps, opts))
      : mode === "check-push"
        ? answer((s) => runPushCheck(s, process.env, realCheckDeps, opts))
        : main();
void job.finally(() => process.exit(0));
