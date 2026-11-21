// Butler session 的 butler-sessions MCP server（设计文档 2026-10-23 第二步）。先读出要用的变量，再清掉环境变量里的模型 key。
import { sanitizeEnv } from "./sanitize";
import { SessionsServer } from "./sessions-server";
import { serveStdio } from "./stdio";
import { sessionsOptionsFromEnv } from "./sessions-options";

const options = sessionsOptionsFromEnv(process.env);
sanitizeEnv(process.env);

if (!options) {
  process.stderr.write("butler-sessions: BUTLER_SCOPE=butler, BUTLER_TICKET or BUTLER_FEATURE, BUTLER_CONTROL_REQUESTS and BUTLER_CONTROL_RESULTS are required\n");
  process.exit(2);
}
const server = new SessionsServer(options);
serveStdio(server, process.stdin, process.stdout);
// claude 退出时关掉 stdin：撤回没人再等的请求，跟着退出，不留下孤儿进程。
process.stdin.on("end", () => {
  server.withdrawAll();
  process.exit(0);
});
