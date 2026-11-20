import type { DevSendResult, ForkView, RememberResult } from "../../shared/fork";
import type { DevSender } from "../fork/dev-send";
import type { ForkService } from "../fork/fork-service";
import { devMessageArg, forkIdArg, forkQuestionArg, sessionIdArg } from "./validate";

interface Deps {
  fork: Pick<ForkService, "ask" | "reaskFull" | "list" | "sendConclusion" | "remember">;
  devSend: Pick<DevSender, "send">;
}

/**
 * 对话 tab 的分叉讨论和「发给开发 session」（UI 重做第 5 层）。先校验参数再调服务；
 * ForkService 拒绝时抛 ForkError，经 toIpcResult 变成 { ok: false, code }。session id 可以是链上任意一段。
 */
export function forkHandlers(d: Deps): {
  ask: (rootSessionId: unknown, forkId: unknown, question: unknown) => { forkId: number };
  sendConclusion: (forkId: unknown) => Promise<DevSendResult>;
  reaskFull: (forkId: unknown) => { forkId: number };
  list: (anyId: unknown) => ForkView[];
  remember: (forkId: unknown) => Promise<{ result: RememberResult }>;
  convSend: (anyId: unknown, text: unknown) => Promise<DevSendResult>;
} {
  return {
    ask(rootSessionId, forkId, question) {
      const sid = sessionIdArg(rootSessionId);
      // null 开一个新分叉，数字接着问那个分叉（ForkService.ask 自己分 askNew / askMore）。
      const fid = forkId === null ? null : forkIdArg(forkId);
      return d.fork.ask(sid, fid, forkQuestionArg(question));
    },
    async sendConclusion(forkId) {
      return d.fork.sendConclusion(forkIdArg(forkId));
    },
    reaskFull(forkId) {
      return d.fork.reaskFull(forkIdArg(forkId));
    },
    list(anyId) {
      return d.fork.list(sessionIdArg(anyId));
    },
    async remember(forkId) {
      return { result: await d.fork.remember(forkIdArg(forkId)) };
    },
    async convSend(anyId, text) {
      const sid = sessionIdArg(anyId);
      return d.devSend.send(sid, devMessageArg(text));
    },
  };
}
