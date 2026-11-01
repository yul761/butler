// 总控 session 的 butler-sessions MCP server（设计文档 2026-10-23 第二步）。先读出要用的变量，再清掉环境变量里的模型 key。
import { HEADLESS_SESSION_PREFIX } from "../src/shared/hook-envelope";
import { sanitizeEnv } from "./sanitize";
import { SessionsServer, serveStdio } from "./sessions-server";

const env = process.env;
const ticketKey = env.BUTLER_TICKET ?? "";
// feature 总控（设计文档 2026-10-26）：BUTLER_FEATURE 是正整数。
const featureId = /^[1-9]\d{0,15}$/.test(env.BUTLER_FEATURE ?? "") ? Number(env.BUTLER_FEATURE) : null;
// epic session（设计文档 2026-11-01）：BUTLER_EPIC 是正整数；feature 总控属于 epic 时 BUTLER_FEATURE_EPIC=1。
const epicId = /^[1-9]\d{0,15}$/.test(env.BUTLER_EPIC ?? "") ? Number(env.BUTLER_EPIC) : null;
const featureInEpic = env.BUTLER_FEATURE_EPIC === "1";
const requestsDir = env.BUTLER_CONTROL_REQUESTS ?? "";
const resultsDir = env.BUTLER_CONTROL_RESULTS ?? "";
const from = env.BUTLER_SESSION && !env.BUTLER_SESSION.startsWith(HEADLESS_SESSION_PREFIX) ? env.BUTLER_SESSION : null;
sanitizeEnv(env);

if ((!ticketKey && featureId === null && epicId === null) || !requestsDir || !resultsDir) {
  process.stderr.write("butler-sessions: BUTLER_TICKET, BUTLER_FEATURE or BUTLER_EPIC, BUTLER_CONTROL_REQUESTS and BUTLER_CONTROL_RESULTS are required\n");
  process.exit(2);
}
const lang = env.BUTLER_LANG === "en" ? "en" : "zh";
const server = new SessionsServer({ scope: epicId !== null ? { epicId } : featureId !== null ? { featureId, epic: featureInEpic } : { ticketKey }, lang, from, requestsDir, resultsDir });
serveStdio(server, process.stdin, process.stdout);
// claude 退出时关掉 stdin：撤回没人再等的请求，跟着退出，不留下孤儿进程。
process.stdin.on("end", () => {
  server.withdrawAll();
  process.exit(0);
});
