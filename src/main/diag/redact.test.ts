import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../db/database";
import { collectRedactTerms, redactDeep, redactText, redactedDiagnostics, type RedactTerms } from "./redact";

const NONE: RedactTerms = { home: [], users: [], paths: [], titles: [], epics: [], repos: [], branches: [], tickets: [] };
const terms = (t: Partial<RedactTerms>): RedactTerms => ({ ...NONE, ...t });

describe("redactText: generic paths", () => {
  const cases: [string, string][] = [
    ["open /Users/alice/Code/acme-api/src/x.ts failed", "open <path> failed"],
    ["cwd=/home/bob/work/secret", "cwd=<path>"],
    ['spawn "/opt/homebrew/bin/claude" exited', 'spawn "<path>" exited'],
    ["read ~/projects/acme/README.md", "read <path>"],
    ["relative src/main/acme.ts:12 threw", "relative <path> threw"],
    ["C:\\Users\\alice\\Code\\acme\\x.ts not found", "<path> not found"],
    ["c:/Users/alice/Code/acme ok", "<path> ok"],
    ["D:\\work\\acme", "<path>"],
    ['{"cwd":"C:\\\\Users\\\\alice\\\\acme"}', '{"cwd":"<path>"}'],
    ["share \\\\fileserver\\team\\acme here", "share <path> here"],
    ["branch feature/acme-login pushed", "branch <path> pushed"],
    ["repo acme-corp/payments merged", "repo <path> merged"],
    ["(/var/folders/xy/T/shipherd-1)", "(<path>)"],
  ];
  for (const [input, want] of cases) it(input, () => expect(redactText(input, NONE)).toBe(want));

  it("keeps plain log text and numbers", () => {
    expect(redactText("perf: window 60000 ms, eld p99 12.5", NONE)).toBe("perf: window 60000 ms, eld p99 12.5");
    expect(redactText("ratio 3/60 sessions", NONE)).toBe("ratio 3/60 sessions");
  });
});

describe("redactText: URLs, emails, ticket keys", () => {
  it("URLs of any host", () => {
    expect(redactText("open https://github.com/acme/api/pull/7 now", NONE)).toBe("open <url> now");
    expect(redactText("see http://github.acme.internal/x", NONE)).toBe("see <url>");
    expect(redactText("file:///C:/Users/alice/a.txt", NONE)).toBe("<url>");
  });
  it("emails", () => expect(redactText("author alice@acme.com pushed", NONE)).toBe("author <email> pushed"));
  it("anything shaped like a ticket key", () => {
    expect(redactText("ticket ACME-1234 started; PAY-7 done", NONE)).toBe("ticket <ticket> started; <ticket> done");
  });
});

describe("redactText: known terms", () => {
  it("home folder in every separator style, including spaces", () => {
    const t = terms({ home: ["/Users/John Doe"] });
    expect(redactText("at /Users/John Doe/Code/x", t)).toBe("at <path>");
    expect(redactText("home is /Users/John Doe", t)).toBe("home is ~");
  });
  it("Windows home with spaces, backslashes and JSON escaping, any case", () => {
    const t = terms({ home: ["C:\\Users\\John Doe"] });
    expect(redactText("at C:\\Users\\John Doe\\Code\\x", t)).toBe("at <path>");
    expect(redactText("at c:\\users\\john doe", t)).toBe("at ~");
    expect(redactText('"C:\\\\Users\\\\John Doe\\\\acme"', t)).toBe('"<path>"');
    expect(redactText("at C:/Users/John Doe/acme", t)).toBe("at <path>");
  });
  it("paths with spaces outside the home folder", () => {
    const t = terms({ paths: ["/Volumes/Work Stuff/acme"] });
    expect(redactText("repo /Volumes/Work Stuff/acme ready", t)).toBe("repo <path> ready");
  });
  it("ticket titles, epic names, repo and branch names, ticket keys", () => {
    const t = terms({ titles: ["Fix the Payroll export"], epics: ["Project Falcon"], repos: ["payroll-svc"], branches: ["hotfix-payroll"], tickets: ["pay-12"] });
    expect(redactText("started Fix the payroll export for Project Falcon", t)).toBe("started <title> for <epic>");
    expect(redactText("payroll-svc on hotfix-payroll", t)).toBe("<repo> on <branch>");
    expect(redactText("pay-12 merged", t)).toBe("<ticket> merged");
  });
  it("short repo names only as whole words", () => {
    const t = terms({ repos: ["api"] });
    expect(redactText("api crashed; rapid restart", t)).toBe("<repo> crashed; rapid restart");
  });
  it("the user name as a word", () => {
    const t = terms({ users: ["alice"] });
    expect(redactText("user Alice logged; malice stays", t)).toBe("user <user> logged; malice stays");
  });
  it("longer terms win over their prefixes", () => {
    const t = terms({ repos: ["acme"], titles: ["acme rollout plan"] });
    expect(redactText("acme rollout plan for acme", t)).toBe("<title> for <repo>");
  });
  it("regex characters in terms are literal", () => {
    const t = terms({ titles: ["Fix (a+b)* [x]?"] });
    expect(redactText("Fix (a+b)* [x]? done", t)).toBe("<title> done");
  });
});

describe("redactDeep", () => {
  it("redacts every string and object key, keeps numbers and booleans", () => {
    const t = terms({ repos: ["acme"] });
    const out = redactDeep({ a: "acme here", n: 3, b: true, list: ["/Users/x/acme", { "op:acme": 1 }] }, t);
    expect(out).toEqual({ a: "<repo> here", n: 3, b: true, list: ["<path>", { "op:<repo>": 1 }] });
  });
});

describe("collectRedactTerms", () => {
  function db(): DatabaseSync {
    const d = new DatabaseSync(":memory:");
    migrate(d);
    return d;
  }
  it("reads ticket titles, keys, branches, paths and epic names from the database", () => {
    const d = db();
    d.prepare("INSERT INTO features (name, workspace_dir, created_at) VALUES (?, ?, 0)").run("Project Falcon", "/Users/alice/epics/falcon");
    d.prepare("INSERT INTO tickets (key, title, repo_path, work_mode, worktree_path, branch, created_at) VALUES (?, ?, ?, 'worktree', ?, ?, 0)")
      .run("PAY-12", "Fix payroll export", "/Users/alice/Code/payroll-svc", "/Users/alice/Code/payroll-svc-wt/PAY-12", "feature/PAY-12");
    const t = collectRedactTerms(d);
    expect(t.titles).toContain("Fix payroll export");
    expect(t.epics).toContain("Project Falcon");
    expect(t.tickets).toContain("PAY-12");
    expect(t.branches).toContain("feature/PAY-12");
    expect(t.paths).toEqual(expect.arrayContaining(["/Users/alice/Code/payroll-svc", "/Users/alice/epics/falcon"]));
    expect(t.repos).toContain("payroll-svc");
    expect(redactText("Fix payroll export in payroll-svc (Project Falcon)", t)).toBe("<title> in <repo> (<epic>)");
  });
  it("splits slugs into owner and repo", () => {
    const d = db();
    const cols = (d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .find((r) => (d.prepare(`PRAGMA table_info(${r.name})`).all() as { name: string }[]).some((c) => c.name === "repo_slug"));
    expect(cols).toBeTruthy();
    const t = collectRedactTerms(d, { slugs: ["acme-corp/payments", "ghe.acme.io/team/infra"] });
    expect(t.repos).toEqual(expect.arrayContaining(["acme-corp/payments", "acme-corp", "payments", "ghe.acme.io", "team", "infra"]));
  });
  it("skips empty and very short values", () => {
    const t = collectRedactTerms(db(), { titles: ["", "x"], paths: ["/"] });
    expect(t.titles).toEqual([]);
    expect(t.paths).toEqual([]);
  });
});

describe("redactedDiagnostics", () => {
  it("marks the file and leaves no trace of the terms anywhere", () => {
    const t = terms({ home: ["/Users/alice"], users: ["alice"], titles: ["Secret launch"], repos: ["acme"] });
    const file = {
      kind: "shipherd-diagnostics", schema: 1, generatedAt: "2026-11-21T00:00:00.000Z",
      app: { version: "4.0.0", versions: {}, mode: "on" }, system: { platform: "darwin", arch: "arm64", osRelease: "25.2.0", cpus: { model: "M", count: 1 }, memory: { totalMb: 1, freeMb: 1 } },
      processes: [], mainMemory: {}, perf: { current: { ops: { "acme:scan": 1 } }, history: [] },
      logTail: ["start Secret launch in /Users/alice/Code/acme", "alice opened acme"],
    };
    const out = redactedDiagnostics(file as never, t);
    const text = JSON.stringify(out);
    for (const s of ["alice", "Secret", "acme", "/Users"]) expect(text).not.toContain(s);
    expect(out.redacted).toBe(true);
    expect(out.app.version).toBe("4.0.0");
    expect(out.generatedAt).toBe("2026-11-21T00:00:00.000Z");
  });
});

describe("redactText: speed", () => {
  it("1000 log lines against 6000 known terms stays fast", () => {
    const t = terms({ titles: Array.from({ length: 3000 }, (_, i) => `ticket title number ${i}`), paths: Array.from({ length: 3000 }, (_, i) => `/Users/alice/Code/repo-${i}`) });
    const lines = Array.from({ length: 1000 }, (_, i) => `2026-11-21T00:00:00.000Z session ${i} started ticket title number ${i % 3000} in /Users/alice/Code/repo-${i}`);
    const start = performance.now();
    const out = lines.map((l) => redactText(l, t));
    expect(performance.now() - start).toBeLessThan(3000);
    expect(out[5]).toBe("2026-11-21T00:00:00.000Z session 5 started <title> in <path>");
  });
});

describe("redactText: review findings", () => {
  it("emails and hosts are replaced whole even when they contain a known name", () => {
    const t = terms({ users: ["alice"], repos: ["payroll", "jira"] });
    expect(redactText("author alice@acme-corp.com pushed", t)).toBe("author <email> pushed");
    expect(redactText("bob.smith@payroll.acme-corp.com", t)).toBe("<email>");
    expect(redactText("open https://jira.acme-corp.com now", t)).toBe("open <url> now");
  });

  it("known names never rewrite a placeholder", () => {
    const t = terms({ repos: ["url", "path", "email"] });
    expect(redactText("see https://x.example.com and /tmp/a", t)).toBe("see <url> and <path>");
  });

  it("Chinese names are replaced without spaces around them", () => {
    const t = terms({ epics: ["猎鹰计划"], titles: ["修复工资导出"], repos: ["acme", "payroll-svc"] });
    expect(redactText("epic 猎鹰计划启动", t)).toBe("epic <epic>启动");
    expect(redactText("开始修复工资导出", t)).toBe("开始<title>");
    expect(redactText("在acme仓库里", t)).toBe("在<repo>仓库里");
    expect(redactText("帮我修复payroll-svc的导出", t)).toBe("帮我修复<repo>的导出");
    // ASCII 的词还是要整词：acme 不换 acmeville 里的那段。
    expect(redactText("acmeville", t)).toBe("acmeville");
  });

  it("bare company hostnames are replaced, public ones and file names stay", () => {
    expect(redactText("ssh: Could not resolve hostname github.acme-corp.com: nodename", NONE)).toBe("ssh: Could not resolve hostname <host>: nodename");
    expect(redactText("gh: HTTP 401 for host ghe.acmecorp.internal", NONE)).toBe("gh: HTTP 401 for host <host>");
    expect(redactText("fetched github.com and api.anthropic.com, wrote main.log and index.ts", NONE)).toBe("fetched github.com and api.anthropic.com, wrote main.log and index.ts");
    expect(redactText("at async LessonRunner.process (node:internal)", NONE)).toBe("at async LessonRunner.process (node:internal)");
  });

  it("words between two path pieces count as one path", () => {
    expect(redactText("C:\\Users\\alice\\Code\\Acme Secret Corp\\x.ts", NONE)).toBe("<path>");
    expect(redactText("open /Users/a/OneDrive - Acme Corp/notes.md done", NONE)).toBe("open <path> done");
  });

  it("keys with underscores count as tickets", () => {
    expect(redactText("MY_PROJ-12 done", NONE)).toBe("<ticket> done");
  });

  it("common branch names and Shipherd's own name stay readable", () => {
    const t = terms({ branches: ["main", "feature/x"], repos: ["Shipherd", "acme"] });
    expect(redactText("shipherd: merged into main from acme", t)).toBe("shipherd: merged into main from <repo>");
  });
});

describe("redactedDiagnostics: log free text", () => {
  const file = (logTail: string[]) => ({
    kind: "shipherd-diagnostics", schema: 1, generatedAt: "2026-11-21T00:00:00.000Z",
    app: { version: "4.0.0", versions: {}, mode: "on" }, system: { platform: "darwin", arch: "arm64", osRelease: "25.2.0", cpus: { model: "M", count: 1 }, memory: { totalMb: 1, freeMb: 1 } },
    processes: [], mainMemory: {}, perf: { current: {}, history: [] }, logTail,
  }) as never;

  it("quoted text and non-ASCII words in the log are replaced", () => {
    const out = redactedDiagnostics(file([
      'memory epic:3: dropped 1 oldest note(s): "we signed with Big Bank, live at month end"',
      'title "Fix \\"export\\" bug" saved',
      "fork failed: 我们和招商银行签了合同 retry",
      "José renamed it",
    ]), NONE);
    expect(out.logTail).toEqual([
      'memory epic:3: dropped 1 oldest note(s): "<text>"',
      'title "<text>" saved',
      "fork failed: <text> retry",
      "<text> renamed it",
    ]);
  });

  it("plain English log lines are left alone", () => {
    const line = "2026-11-21T00:00:00.000Z perf: 60s eld p50=0.8 p99=2.5 → ok";
    expect(redactedDiagnostics(file([line]), NONE).logTail).toEqual([line]);
  });
});

describe("collectRedactTerms: more columns", () => {
  it("reads titles, branches, ticket keys, epic block names and repo dirs from the other tables", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db as never);
    const cols = (table: string) => (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("sessions")).toContain("git_branch");
    expect(cols("blocks")).toContain("name");
    const t = collectRedactTerms(db as never, { paths: ["/Users/alice/Library/Application Support/Shipherd"] });
    // 额外传进来的目录不拿最后一段当仓库名。
    expect(t.repos).not.toContain("Shipherd");
  });
});
