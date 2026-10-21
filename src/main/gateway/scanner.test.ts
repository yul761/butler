import { describe, expect, it } from "vitest";
import type { ScanRule } from "../../shared/llm";
import { DEFAULT_TICKET_PATTERN, maskSample, scanOutbound, type ScanOptions } from "./scanner";

const opts: ScanOptions = { ticketPattern: DEFAULT_TICKET_PATTERN, originals: [] as string[] };
const rules = (text: string, o = opts) => scanOutbound([text], o).map((h) => h.rule);

/** 应拒发：[应命中的规则, 文本]。 */
const SHOULD_BLOCK: [ScanRule, string][] = [
  ["secret", "把 sk-proj-abcdEFGH1234567890xyz 填到配置里"],
  ["secret", "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
  ["secret", "AKIAIOSFODNN7EXAMPLE 是测试账号"],
  ["secret", "数据库密码：hunter2024"],
  ["secret", "-----BEGIN RSA PRIVATE KEY-----"],
  ["secret", "jwt 是 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
  ["secret", "回滚到 3f786850e387550fdab836ed7e6dc881de23001b"],
  ["secret", "api_key=AbCdEf123456"],
  ["secret", "xoxb-1234567890-abcdefghij 是 slack 的"],
  ["url", "详见 https://jira.example.com/browse/X"],
  ["url", "文档在www.example.org上"],
  ["domain", "连到db01.corp看日志"],
  ["domain", "部署到 api.mycompany.com"],
  ["ip", "服务器 10.12.0.7 挂了"],
  ["ip", "fe80:0:0:0:200:f8ff:fe21:67cf"],
  ["email", "找zhang.san@example.com确认"],
  ["path", "改一下 /etc/nginx/nginx.conf"],
  ["path", "日志在 ~/logs/app.log"],
  ["path", "C:\\Users\\zhang\\repo 下面"],
  ["path", "\\\\fileserver\\share\\doc"],
  ["path", "看src/main/gateway/scanner.ts第3行"],
  ["ticket", "顺便修一下 PROJ-1234"],
  ["ticket", "和ABC-9一起上线"],
  ["ticket", "顺便修一下 PROJ\u200b-12"],
  ["ticket", "顺便修一下 PROJ\u201312"],
];

/** 不应误伤。 */
const SHOULD_PASS = [
  "等 review，预计周三合并",
  "PR #123 已经批准，可以合并了",
  "版本 v2.1.306 修复了 UTF-8 编码问题",
  "按 ISO-8601 格式输出日期 2026-10-21",
  "SHA-256 校验通过",
  "16:00 跑晚间 handoff，耗时 12:30:45",
  "A/B 测试和前端/后端联调",
  "完成率 85%，还剩 3 个子任务",
  "第 3/4 步完成",
  "改 staging 配置，打开 feature flag",
  "README.md 和 config.yaml 要同步",
  "Node.js 和 Next.js 升级",
  "用 1.5 倍超时重试",
  "token 用量 1200",
  "下周一 9 点和产品开会，讨论退款流程",
  "[[T_ab12]] 的 PR 等 [[P_x7k2]] review，[[R_9fqz]] 的 [[B_m3n4]] 要 rebase",
];

describe("scanOutbound corpus", () => {
  it.each(SHOULD_BLOCK)("blocks %s: %s", (rule, text) => {
    expect(rules(text)).toContain(rule);
  });

  it.each(SHOULD_PASS)("does not flag: %s", (text) => {
    expect(rules(text)).toEqual([]);
  });
});

describe("scanOutbound options", () => {
  it("finds a dictionary value that survived pseudonymization, ignoring case", () => {
    expect(rules("请 acme 的同事确认", { ...opts, originals: ["张三", "ACME"] })).toEqual(["known"]);
  });

  it("finds a dictionary value split by invisible characters or spelled with a dash variant", () => {
    expect(rules("请 ac\u200bme 的同事确认", { ...opts, originals: ["ACME"] })).toEqual(["known"]);
    expect(rules("分支 feature\u2013login", { ...opts, originals: ["feature-login"] })).toEqual(["known"]);
    expect(rules("分支 ｆｅａｔｕｒｅ－ｌｏｇｉｎ", { ...opts, originals: ["Feature-Login"] })).toEqual(["known"]);
  });

  it("treats originals as literals and skips empty ones", () => {
    expect(rules("a.b (x) 普通文本", { ...opts, originals: ["", "a+b", "(y)", ".*"] })).toEqual([]);
    expect(rules("看 a+b 这个", { ...opts, originals: ["", "a+b"] })).toEqual(["known"]);
  });

  it("skips the ticket rule when the pattern is null (full level) and falls back to the default for an invalid pattern", () => {
    expect(rules("顺便修一下 PROJ-1234", { ...opts, ticketPattern: null })).toEqual([]);
    expect(rules("顺便修一下 PROJ-1234", { ...opts, ticketPattern: "[" })).toEqual(["ticket"]);
    expect(rules("fix proj#12", { ...opts, ticketPattern: "[a-z]+#\\d+" })).toEqual(["ticket"]);
  });

  it("still applies the other rules when the ticket rule is off", () => {
    expect(rules("发到 a@b.io", { ticketPattern: null, originals: [] })).toEqual(["email", "domain"]);
  });

  it("normalizes full-width text before scanning and reports each rule once, masked", () => {
    expect(rules("顺便修一下ＰＲＯＪ－１２")).toEqual(["ticket"]);
    const hits = scanOutbound(["https://a.example.com 和 https://b.example.com"], opts);
    expect(hits.filter((h) => h.rule === "url")).toEqual([{ rule: "url", sample: "htt…(21)" }]);
    expect(maskSample("密码很长很长")).toBe("密码很…(6)");
  });

  it("scans every text it is given", () => {
    expect(scanOutbound(["没问题", "也没问题", "发邮件到 a@b.io"], opts).map((h) => h.rule)).toEqual(["email", "domain"]);
  });

  it("is stable across repeated calls (no shared regex state)", () => {
    const text = "[[T_ab12]] 和 PROJ-12";
    expect(rules(text)).toEqual(["ticket"]);
    expect(rules(text)).toEqual(["ticket"]);
    expect(rules("[[T_ab12]] 的 PR")).toEqual([]);
  });
});

describe("scanOutbound performance", () => {
  const N = 50_000;
  const shapes: [string, string][] = [
    ["a.", "a.".repeat(N / 2)],
    ["1.", "1.".repeat(N / 2)],
    ["a-", "a-".repeat(N / 2)],
    ["a/", "a/".repeat(N / 2)],
    ["a./", "a./".repeat(N / 3)],
    ["a@", "a@".repeat(N / 2)],
    ["A1", "A1".repeat(N / 2)],
    ["AAAA", "A".repeat(N)],
    ["hex", "f".repeat(N) + "g"],
    ["eyJ-", "eyJ-".repeat(N / 4)],
    ["1:", "1:".repeat(N / 2)],
    ["x://", "x:".repeat(N / 2)],
    ["spaces", "a ".repeat(N / 2)],
  ];
  it.each(shapes)("scans an adversarial %s string quickly", (_name, text) => {
    const start = performance.now();
    scanOutbound([text], { ticketPattern: DEFAULT_TICKET_PATTERN, originals: ["acme", "feature-login", "张三"] });
    expect(performance.now() - start).toBeLessThan(200);
  });
});
