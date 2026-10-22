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
  // 被占位符切开的密钥 / 邮箱
  ["secret", "ghp_xK9[[P_kidk]]q2LmZ7vBn4RtYs8PcDe3HfJa6GoNi1T"],
  ["secret", "sk-[[S_ab12]]-abcdEFGH1234567890xyz"],
  ["secret", "AKIAIOS[[S_ab12]]NN7EXAMPLE"],
  ["email", "zhang.[[P_ab12]]@example.xyz"],
  // 中文紧贴路径
  ["path", "改一下/etc/nginx/nginx.conf"],
  ["path", "日志在~/logs/app.log"],
  ["path", "看/etc/hosts"],
  ["path", "在/Users/zhang下"],
  ["path", "看/Users/zhang/billing/secrets.yaml"],
  ["path", "//fileserver/share"],
  ["path", "读 $HOME/.aws/credentials"],
  ["path", "C:/Users/zhang"],
  // 压缩 IPv6
  ["ip", "2001:db8::1"],
  ["ip", "地址 fe80::1%en0"],
  ["ip", "::1"],
  ["ip", "::ffff:10.0.0.1"],
  // 域名
  ["domain", "api.mycompany.co.uk"],
  ["domain", "x.example.de"],
  ["domain", "a.b.jp"],
  ["domain", "api.foo.app"],
  ["domain", "db01.corp"],
  ["domain", "db01.intra"],
  ["domain", "a.b.private"],
  ["domain", "ci.corp.dev"],
  ["domain", "x.com.cn"],
  ["domain", "b.ac.jp"],
  ["domain", "foo.example.com.au"],
  ["secret", "数据库密码：hunter2024"],
  ["secret", "密码是hunterabc"],
  ["domain", "jira.mycompany.xyz/browse/X"],
  ["domain", "nas.home.arpa"],
  ["domain", "svc.gov"],
  ["domain", "u.edu"],
  // 口令 / token 的其他写法
  ["secret", "密码是hunter2024"],
  ["secret", "密码 hunter2024"],
  ["secret", "数据库密码是hunter2024"],
  ["secret", "password is hunter2024"],
  ["secret", "Authorization: Bearer abcdef0123456789abcdef"],
  // Stripe 文档里的示例 key；拆开写，免得 GitHub 的 secret scanning 把测试数据当成真 key 拦下推送。
  ["secret", "sk_" + "test_4eC39HqLyjWDarjtT1zdp7dc"],
  ["secret", "sk_" + "live_4eC39HqLyjWDarjtT1zdp7dc"],
  ["secret", "rk_" + "live_4eC39HqLyjWDarjtT1zdp7dc"],
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
  "std::vector 和 Foo::bar 的用法",
  "this.private",
  "import.meta.env.DEV",
  "process.env.HOME",
  "密码是 bcrypt 哈希",
  "令牌 OAuth2 刷新",
  "密钥 ed25519 签名",
  "密码 sha256 哈希",
  "用 JSON.parse 解析",
  "Array.from",
  "Promise.all",
  "this.state",
  "path.join",
  "db.prepare",
  "ipcMain.handle 注册",
  "fs.readFile",
  "Date.now",
  "crypto.randomUUID",
  "window.location",
  "res.status(500)",
  "brief.narrativeStatus 为 blocked",
  "app.db 迁移",
  "改 vite.config",
  "和Mr.Wang确认",
  "gpt-4o.mini",
  "sonnet.latest",
  "LGTM.Merged",
  "user.id",
  "node.is",
  "item.to",
  "row.at(0)",
  "x.in",
  "this.app",
  "user.name",
  "logger.info",
  "rect.top",
  "navigator.onLine",
  "env.dev",
  "printer.local",
  "API 密钥 safeStorage 加密",
  "密钥 rotation 完成",
  "令牌 refresh 逻辑",
  "密码 hashing 改用 argon2",
  "GPT-4 和 GPT-5",

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

  it("known hits report the length only, never characters of the original", () => {
    const hits = scanOutbound(["请 acme 的同事确认"], { ...opts, originals: ["ACME"] });
    expect(hits).toEqual([{ rule: "known", sample: "…(4)" }]);
  });

  it("path samples start at the path, including a drive letter", () => {
    expect(scanOutbound(["C:/Users/zhang"], opts)[0]).toEqual({ rule: "path", sample: "C:/…(14)" });
    expect(scanOutbound(["在 /Users/zhang"], opts)[0]).toEqual({ rule: "path", sample: "/Us…(12)" });
  });

  it("does not report a ticket for a word cut by the scan window", () => {
    for (let k = 180; k <= 270; k++) expect(rules("中".repeat(k) + "SHA-256")).toEqual([]);
  });

  it("is stable across repeated calls (no shared regex state)", () => {
    const text = "[[T_ab12]] 和 PROJ-12";
    expect(rules(text)).toEqual(["ticket"]);
    expect(rules(text)).toEqual(["ticket"]);
    expect(rules("[[T_ab12]] 的 PR")).toEqual([]);
  });
});

/**
 * ReDoS / 线性时间守卫：对抗性输入的扫描时间必须随长度线性增长。
 * 不用固定的毫秒预算（CI runner 比开发机慢好几倍，200 ms 在 macOS 和 Windows runner 上都超过了），而是在同一次运行里
 * 比较 N 和 N/4 两个长度：线性时约 4 倍，二次方约 16 倍，阈值取 8。每个长度取多次中的最小值以压掉 GC/调度噪声。
 * 另有一个宽松的绝对上限，兜住"线性但常数巨大"或灾难性回溯（这台机器上 N=100k 约 0.1 s，CI 约 0.3 s）。
 */
describe("scanOutbound performance", () => {
  const N = 100_000;
  const SCALING_LIMIT = 8;
  const ABSOLUTE_LIMIT_MS = 2000;
  const shapes: [string, (n: number) => string][] = [
    ["a.", (n) => "a.".repeat(n / 2)],
    ["1.", (n) => "1.".repeat(n / 2)],
    ["a-", (n) => "a-".repeat(n / 2)],
    ["a/", (n) => "a/".repeat(n / 2)],
    ["a./", (n) => "a./".repeat(n / 3)],
    ["a@", (n) => "a@".repeat(n / 2)],
    ["A1", (n) => "A1".repeat(n / 2)],
    ["AAAA", (n) => "A".repeat(n)],
    ["hex", (n) => "f".repeat(n) + "g"],
    ["eyJ-", (n) => "eyJ-".repeat(n / 4)],
    ["1:", (n) => "1:".repeat(n / 2)],
    ["x://", (n) => "x:".repeat(n / 2)],
    ["a.a/", (n) => "a.".repeat(n / 2) + "/"],
    ["a.md", (n) => "a.md".repeat(n / 4)],
    ["1::", (n) => "1::".repeat(n / 3)],
    ["a:b", (n) => "a:b:".repeat(n / 4)],
    ["::", (n) => ":".repeat(n)],
    ["Bearer", (n) => "Bearer a".repeat(n / 8)],
    ["pw is", (n) => "password is ".repeat(n / 12)],
    ["spaces", (n) => "a ".repeat(n / 2)],
  ];
  const scanOpts: ScanOptions = { ticketPattern: DEFAULT_TICKET_PATTERN, originals: ["acme", "feature-login", "张三"] };
  /** runs 次扫描中最快的一次（毫秒）。 */
  const fastest = (text: string, runs: number) => {
    let best = Infinity;
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      scanOutbound([text], scanOpts);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };
  it.each(shapes)("scans an adversarial %s string in linear time", (_name, make) => {
    const small = make(N / 4);
    const large = make(N);
    fastest(small, 1); // 预热：让正则先编译、JIT 先热起来，不算进小样本。
    const tSmall = fastest(small, 3);
    const tLarge = fastest(large, 2);
    expect(tLarge).toBeLessThan(ABSOLUTE_LIMIT_MS);
    // 小样本快到计时器分辨率以下时比值没有意义；这种情况下绝对上限已足以说明没有爆炸。
    if (tSmall >= 1) expect(tLarge / tSmall).toBeLessThan(SCALING_LIMIT);
  }, 30_000);
});
