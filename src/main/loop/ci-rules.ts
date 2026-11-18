import { createHash } from "node:crypto";
import { compilePattern } from "../../shared/loop-policy";
import type { RunInfo } from "../tickets/gh-loop";

/**
 * CI 失败的确定性分类（工作流 I，设计补充第 4.2 节）：先看 job 信息，再看名单上的测试，再看代码类关键字、名单上的检查、环境类关键字，
 * 再看失败的是不是装依赖这一步。都判断不了返回 null，交给后台模型（ci_classify）。纯函数，不调 gh、不调模型。
 */

export type CiCategory = "env" | "flaky" | "code";
export type CiSource = "job" | "list" | "rule" | "model" | "fallback";

export interface CiVerdict {
  category: CiCategory;
  source: CiSource;
  /** 机器可读的理由（job:no_steps、env:ETIMEDOUT、list:<名字>、code:error TS…）或模型的一句话。 */
  reason: string;
}

export interface CiRuleConfig {
  envPatterns: readonly string[];
  codePatterns: readonly string[];
  /** 策略里手写的 flaky 名单（ci.flakyTests：检查名或测试名，模式写法同 envPatterns）。 */
  flaky: readonly string[];
  /** ci_flaky_list 里的名单（自动列入的和在 flaky 名单上手动加的）：按种类、整个名字精确匹配。 */
  listed?: { checks: readonly string[]; tests: readonly string[] };
}

/** 一个失败的 run：哪些检查、日志尾巴（gh run view --log-failed）、job 信息（gh run view --json）。 */
export interface RunFailure {
  runId: number | null;
  checks: string[];
  log: string | null;
  info: RunInfo | null;
}

/** 内置的环境类关键字：网络、runner、磁盘、限流、包仓库。 */
export const BUILTIN_ENV_PATTERNS: readonly string[] = [
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "socket hang up",
  "network timeout", "network error", "/connect(ion)? timed out/", "/read timed out/", "Could not resolve host", "Temporary failure in name resolution",
  "TLS handshake timeout", "502 Bad Gateway", "503 Service Unavailable", "504 Gateway Time", "/rate limit (exceeded|reached)/",
  "ERR_PNPM_FETCH", "ERR_PNPM_META_FETCH", "ERR_SOCKET_TIMEOUT", "npm ERR! network", "npm error network", "/request to https?:\\/\\/\\S+ failed/",
  "The runner has received a shutdown signal", "lost communication with the server", "The hosted runner encountered an error",
  "The operation was canceled", "No space left on device", "/unable to access 'https?:/", "Connection reset by peer",
  "Service Unavailable", "Internal Server Error", "/failed to download|download failed/",
];

/** 内置的代码类关键字：类型错误、断言、语法、lint、编译。命中就不当环境问题（即使同时有网络字样）。 */
export const BUILTIN_CODE_PATTERNS: readonly string[] = [
  "/error TS\\d+/", "AssertionError", "/expect(ed)?\\(.*\\)\\.(to|not)/", "SyntaxError",
  "/\\d+ problems? \\(\\d+ errors?/", "/error\\[E\\d+\\]/", "/^\\s*FAIL\\s+\\S+\\.(test|spec)\\./m", "/--- FAIL: Test/", "/^FAILED \\S+::/m",
  "/Tests?:\\s+\\d+ failed/", "/✘|×\\s/", "panic:", "Segmentation fault", "/compilation failed|build failed/", "/cannot find (module|symbol)/",
];

/** 装依赖、拉代码、恢复缓存这类步骤：失败在这里又有网络字样，按环境问题。 */
const INSTALL_STEP = /install|setup[- ](node|python|go|java|pnpm)|checkout|cache|download|restore|pull|fetch|bootstrap/i;
const NETWORKY = /network|timed? ?out|timeout|fetch|ECONN|ENOTFOUND|EAI_AGAIN|socket|registry|50[234]|resolve host|unreachable|certificate/i;

/** GitHub 的 --log-failed 每行是「job\tstep\t时间 内容」。 */
export interface LogLine { job: string | null; step: string | null; text: string }

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const STAMP = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\s?/;

export function parseLog(log: string | null): LogLine[] {
  if (!log) return [];
  return log.split(/\r?\n/).map((raw) => {
    const parts = raw.replace(ANSI, "").split("\t");
    if (parts.length >= 3) return { job: parts[0] || null, step: parts[1] || null, text: parts.slice(2).join("\t").replace(STAMP, "") };
    return { job: null, step: null, text: raw.replace(ANSI, "").replace(STAMP, "") };
  });
}

type Matcher = { pattern: string; test: (t: string) => boolean };
const matchers = (ps: readonly string[]): Matcher[] => ps.flatMap((p) => {
  const test = compilePattern(p);
  return test ? [{ pattern: p, test }] : [];
});

const firstHit = (ms: Matcher[], text: string): string | null => ms.find((m) => m.test(text))?.pattern ?? null;

/** 日志里认出的失败测试名（vitest / jest / pytest / go / playwright），去重，最多 20 个。 */
export function failedTests(log: string | null): string[] {
  const out: string[] = [];
  const add = (s: string | undefined): void => {
    const t = s?.trim().replace(/\s+\(\d+(\.\d+)?\s*m?s\)$/, "").trim();
    if (t && t.length <= 300 && !out.includes(t) && out.length < 20) out.push(t);
  };
  for (const { text } of parseLog(log)) {
    let m: RegExpExecArray | null;
    if ((m = /^\s*FAIL\s+(\S+\.(?:test|spec)\.\S+(?:\s+>\s+.+)?)$/.exec(text))) add(m[1]);
    else if ((m = /^FAILED\s+(\S+::\S+)/.exec(text))) add(m[1]);
    else if ((m = /^\s*--- FAIL:\s+(\S+)/.exec(text))) add(m[1]);
    else if ((m = /^\s*(?:✘|×)\s+(?:\d+\s+)?(?:\[[^\]]+\]\s+›\s+)?(.+?›.+)$/.exec(text))) add(m[1]);
    else if ((m = /^\s*\d+\)\s+\[[^\]]+\]\s+›\s+(.+)$/.exec(text))) add(m[1]);
    else if ((m = /^\s*●\s+(.+›.+)$/.exec(text))) add(m[1]);
  }
  return out;
}

/** 报错的那几行（去掉时间、数字、十六进制、临时路径以后）：同一个失败两次算出的签名一样。 */
const ERRORISH = /error|fail|timeout|timed out|refused|reset|exception|✘|×|panic|denied|not found|unavailable|cannot|unable/i;

function normalize(t: string): string {
  return t
    .replace(/\b[0-9a-f]{7,40}\b/gi, "H")
    .replace(/(\/tmp|\/var\/folders|[A-Z]:\\Users\\[^\\]+\\AppData\\Local\\Temp)\S*/gi, "T")
    .replace(/\d+(\.\d+)?/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}

/** 这次失败的签名：检查名 + 报错行（最后 5 行）。没有日志时只有检查名。 */
export function failureSignature(checks: readonly string[], log: string | null): string {
  const lines = parseLog(log).map((l) => l.text).filter((t) => t.trim() !== "");
  const errs = lines.filter((t) => ERRORISH.test(t));
  const pick = (errs.length > 0 ? errs : lines).slice(-5).map(normalize);
  return createHash("sha1").update([...checks].sort().join("\n")).update("\u0000").update(pick.join("\n")).digest("hex").slice(0, 16);
}

/** 失败的步骤：job 信息里第一个 failure 的步骤，没有就看日志的最后一行带步骤名的。 */
export function failedStep(f: RunFailure): string | null {
  for (const j of f.info?.jobs ?? []) {
    if (j.conclusion !== "failure") continue;
    const s = j.steps.find((x) => x.conclusion === "failure");
    if (s) return s.name;
  }
  const lines = parseLog(f.log).filter((l) => l.step);
  return lines.length > 0 ? lines[lines.length - 1].step : null;
}

/** job 层面就能判断的环境问题（不看日志）。 */
export function jobVerdict(info: RunInfo | null): CiVerdict | null {
  if (!info) return null;
  if (info.conclusion === "startup_failure") return { category: "env", source: "job", reason: "job:startup_failure" };
  if (info.conclusion === "cancelled") return { category: "env", source: "job", reason: "job:cancelled" };
  const failed = info.jobs.filter((j) => j.conclusion === "failure" || j.conclusion === "cancelled" || j.conclusion === "startup_failure");
  if (failed.length === 0) return null;
  // 所有失败的 job 都是 0 步：没分到 runner。
  if (failed.every((j) => j.steps.length === 0)) return { category: "env", source: "job", reason: "job:no_steps" };
  // 所有失败的 job 都死在「Set up job」：runner 准备环境时出的错。
  if (failed.every((j) => j.steps.find((s) => s.conclusion === "failure")?.name === "Set up job")) return { category: "env", source: "job", reason: "job:runner_setup" };
  return null;
}

/** 规则判断一个失败的 run；判断不了返回 null。 */
export function classifyCiByRule(f: RunFailure, cfg: CiRuleConfig): CiVerdict | null {
  const job = jobVerdict(f.info);
  if (job) return job;
  const user = matchers(cfg.flaky);
  const listedTests = new Set(cfg.listed?.tests ?? []);
  const listedChecks = new Set(cfg.listed?.checks ?? []);
  // 认出了失败的测试：全都在名单上才算 flaky（有一个不在就是真的失败）；这时检查名在不在名单上不算数。
  const tests = failedTests(f.log);
  if (tests.length > 0 && tests.every((t) => listedTests.has(t) || user.some((m) => m.test(t)))) return { category: "flaky", source: "list", reason: `list:${tests[0]}` };
  const checkHit = tests.length > 0 ? undefined : f.checks.find((c) => listedChecks.has(c) || user.some((m) => m.test(c)));
  const text = parseLog(f.log).map((l) => l.text).join("\n");
  if (!text.trim()) return checkHit ? { category: "flaky", source: "list", reason: `list:${checkHit}` } : null;
  // 代码类关键字先于名单上的检查名：名单上的检查真出了类型错误、断言失败，按代码问题算。
  const code = firstHit(matchers([...cfg.codePatterns, ...BUILTIN_CODE_PATTERNS]), text);
  if (code) return { category: "code", source: "rule", reason: `code:${code}` };
  if (checkHit) return { category: "flaky", source: "list", reason: `list:${checkHit}` };
  const env = firstHit(matchers([...cfg.envPatterns, ...BUILTIN_ENV_PATTERNS]), text);
  if (env) return { category: "env", source: "rule", reason: `env:${env}` };
  const step = failedStep(f);
  if (step && INSTALL_STEP.test(step) && NETWORKY.test(text)) return { category: "env", source: "rule", reason: `step:${step}` };
  return null;
}
