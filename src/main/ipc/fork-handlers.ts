import type { DevSendResult, ForkView, RememberResult } from "../../shared/fork";
import type { DevSender } from "../fork/dev-send";
import type { ForkService } from "../fork/fork-service";
import { devMessageArg, forkIdArg, forkQuestionArg, sessionIdArg } from "./validate";

interface Deps {
  fork: Pick<ForkService, "ask" | "reaskFull" | "list" | "sendConclusion" | "remember">;
  devSend: Pick<DevSender, "send">;
  /** 启动时的健康检查（healthReady）。完成前 claude 路径、butler-hook 都还不知道，ForkService 会误报 no_claude。 */
  ready: () => Promise<void>;
}

/**
 * 对话 tab 的分叉讨论和「发给开发 session」（UI 重做第 5 层）。先校验参数再调服务；
 * ForkService 拒绝时抛 ForkError，经 toIpcResult 变成 { ok: false, code }。session id 可以是链上任意一段。
 * 要跑 claude 的（问、重问、送结论、记下）先等启动健康检查做完；参数不对的不等，马上拒。
 */
export function forkHandlers(d: Deps): {
  ask: (rootSessionId: unknown, forkId: unknown, question: unknown) => Promise<{ forkId: number }>;
  sendConclusion: (forkId: unknown) => Promise<DevSendResult>;
  reaskFull: (forkId: unknown) => Promise<{ forkId: number }>;
  list: (anyId: unknown) => ForkView[];
  remember: (forkId: unknown) => Promise<{ result: RememberResult }>;
  convSend: (anyId: unknown, text: unknown) => Promise<DevSendResult>;
} {
  return {
    async ask(rootSessionId, forkId, question) {
      const sid = sessionIdArg(rootSessionId);
      // null 开一个新分叉，数字接着问那个分叉（ForkService.ask 自己分 askNew / askMore）。
      const fid = forkId === null ? null : forkIdArg(forkId);
      const q = forkQuestionArg(question);
      await d.ready();
      return d.fork.ask(sid, fid, q);
    },
    async sendConclusion(forkId) {
      const id = forkIdArg(forkId);
      await d.ready();
      return d.fork.sendConclusion(id);
    },
    async reaskFull(forkId) {
      const id = forkIdArg(forkId);
      await d.ready();
      return d.fork.reaskFull(id);
    },
    list(anyId) {
      return d.fork.list(sessionIdArg(anyId));
    },
    async remember(forkId) {
      const id = forkIdArg(forkId);
      await d.ready();
      return { result: await d.fork.remember(id) };
    },
    async convSend(anyId, text) {
      const sid = sessionIdArg(anyId);
      return d.devSend.send(sid, devMessageArg(text));
    },
  };
}
