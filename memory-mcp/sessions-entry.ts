// 总控 session 的 butler-sessions MCP server（设计文档 2026-10-23 第二步）。先读出要用的变量，再清掉环境变量里的模型 key。
import { HEADLESS_SESSION_PREFIX } from "../src/shared/hook-envelope";
import { sanitizeEnv } from "./sanitize";
import { SessionsServer, serveStdio } from "./sessions-server";

const env = process.env;
const ticketKey = env.BUTLER_TICKET ?? "";
const requestsDir = env.BUTLER_CONTROL_REQUESTS ?? "";
const resultsDir = env.BUTLER_CONTROL_RESULTS ?? "";
const from = env.BUTLER_SESSION && !env.BUTLER_SESSION.startsWith(HEADLESS_SESSION_PREFIX) ? env.BUTLER_SESSION : null;
sanitizeEnv(env);

if (!ticketKey || !requestsDir || !resultsDir) {
  process.stderr.write("butler-sessions: BUTLER_TICKET / BUTLER_CONTROL_REQUESTS / BUTLER_CONTROL_RESULTS are required\n");
  process.exit(2);
}
const server = new SessionsServer({ ticketKey, from, requestsDir, resultsDir });
serveStdio(server, process.stdin, process.stdout);
// claude 退出时关掉 stdin：撤回没人再等的请求，跟着退出，不留下孤儿进程。
process.stdin.on("end", () => {
  server.withdrawAll();
  process.exit(0);
});
