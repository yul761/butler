import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoLockKey, repoLocks } from "../tickets/repo-lock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalActionKind } from "../../shared/external";
import type { StackRunMode } from "../../shared/stacks";
import { JOB_STACKS_DAILY, JobsRepo } from "../db/jobs-repo";
import { StacksRepo } from "../db/stacks-repo";
import type { ExternalDetail } from "../external/actions";
import { copyRepo, makeRepo, memDb, setOriginUrl, tempDir } from "../test-utils";
import type { CreatePr, PrSnapshot } from "./gh-stack";
import { StackPolicyService } from "./stack-policy";
import { StackService, type StackServiceDeps } from "./stack-service";

// 真的 git 仓库、每次 rebase 还要起一次 node（sequence editor）：整套并行跑时 5 秒不够。
// 夹具已经按文件共享（BTL-240），剩下的是被测代码自己的 git 调用（一个用例几十到上百个进程）：Windows runner 上
// 起一个进程是 macOS 的好几倍、整套并行跑时再翻倍，这里的用例那边常要 10～20 秒，偶尔贴着 30 秒，所以只在 Windows 上给 60 秒。
vi.setConfig({ testTimeout: process.platform === "win32" ? 60_000 : 30_000 });

/** 假的 GitHub：只记 PR 和调用，不联网。git 部分是真的（临时仓库 + 本地 bare 远端）。 */
const fake = vi.hoisted(() => ({
  prs: new Map<number, PrSnapshot>(),
  issues: new Map<number, { title: string; body: string }>(),
  next: 100,
  calls: [] as { fn: string; args: unknown[] }[],
}));

vi.mock("./gh-stack", async (orig) => {
  const real = await orig<typeof import("./gh-stack")>();
  const rec = (fn: string, ...args: unknown[]) => fake.calls.push({ fn, args });
  const pr = (n: number) => {
    const p = fake.prs.get(n);
    if (!p) throw new Error(`no PR #${n}`);
    return p;
  };
  return {
    ...real,
    prCreate: vi.fn(async (_c: string, _s: string | null, p: CreatePr) => {
      rec("prCreate", p);
      const number = fake.next++;
      const url = `https://github.com/acme/app/pull/${number}`;
      fake.prs.set(number, { number, url, state: "OPEN", isDraft: p.draft, title: p.title, body: p.body, base: p.base, head: p.head, headSha: null, labels: [...p.labels] });
      return { number, url };
    }),
    prEditBase: vi.fn(async (_c: string, _s: string | null, n: number, base: string) => (rec("prEditBase", n, base), (pr(n).base = base))),
    prEditTitle: vi.fn(async (_c: string, _s: string | null, n: number, title: string) => (rec("prEditTitle", n, title), (pr(n).title = title))),
    prEditBody: vi.fn(async (_c: string, _s: string | null, n: number, body: string) => (rec("prEditBody", n, body), (pr(n).body = body))),
    prLabel: vi.fn(async (_c: string, _s: string | null, n: number, label: string, add: boolean) => {
      rec("prLabel", n, label, add);
      const p = pr(n);
      p.labels = add ? [...p.labels, label] : p.labels.filter((l) => l !== label);
    }),
    prReady: vi.fn(async (_c: string, _s: string | null, n: number) => (rec("prReady", n), (pr(n).isDraft = false))),
    prClose: vi.fn(async (_c: string, _s: string | null, n: number, comment: string) => (rec("prClose", n, comment), (pr(n).state = "CLOSED"))),
    ensureLabel: vi.fn(async (_c: string, _s: string | null, name: string) => void rec("ensureLabel", name)),
    prView: vi.fn(async (_c: string, _s: string | null, n: number) => (fake.prs.has(n) ? { ...fake.prs.get(n)!, labels: [...fake.prs.get(n)!.labels] } : null)),
    // 和 gh 一样新的在前、最多 OPEN_PR_LIMIT 条
    openPrs: vi.fn(async () => [...fake.prs.values()].filter((p) => p.state === "OPEN").sort((x, y) => y.number - x.number).slice(0, real.OPEN_PR_LIMIT)),
    openPrsForHeads: vi.fn(async (_c: string, _s: string | null, heads: string[]) => [...fake.prs.values()].filter((p) => p.state === "OPEN" && heads.includes(p.head))),
    issueCreate: vi.fn(async (_c: string, _s: string | null, title: string, body: string) => {
      rec("issueCreate", title);
      const number = fake.next++;
      fake.issues.set(number, { title, body });
      return { number, url: `https://github.com/acme/app/issues/${number}` };
    }),
    issueEdit: vi.fn(async (_c: string, _s: string | null, n: number, title: string, body: string) => (rec("issueEdit", n), fake.issues.set(n, { title, body }))),
  };
});

const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function commit(repo: string, file: string, text: string, msg: string): string {
  writeFileSync(join(repo, file), text);
  g(repo, "add", file);
  g(repo, "commit", "-q", "-m", msg);
  return g(repo, "rev-parse", "HEAD");
}

const BRANCHES = ["a", "b", "c", "d"];

/**
 * 从 main 起一条链：每个分支在上一个后面加一个提交（文件 <b>.txt，内容 "<b>\n"，信息 "<b> one"）。
 * 用一次 git fast-import 建完，不 checkout：层数多时（40 层的用例）每层 checkout、add、commit 在 Windows 上要起很多进程。
 */
function chain(repo: string, branches: readonly string[]): void {
  const when = `${Math.floor(Date.now() / 1000)} +0000`;
  const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;
  let from = g(repo, "rev-parse", "main");
  let script = "";
  for (const [i, b] of branches.entries()) {
    script += `commit refs/heads/${b}\nmark :${i + 1}\nauthor Test <test@example.com> ${when}\ncommitter Test <test@example.com> ${when}\n`;
    script += data(`${b} one`) + `from ${from}\nM 100644 inline ${b}.txt\n` + data(`${b}\n`);
    from = `:${i + 1}`;
  }
  execFileSync("git", ["fast-import", "--quiet"], { cwd: repo, input: script, stdio: ["pipe", "ignore", "pipe"] });
}

/** 每种层的组合只真的建一次仓库：git 部分见 gitWorld。 */
const worldTemplates = new Map<string, { remote: string; repo: string; hub: string }>();

/**
 * 栈的 git 部分：bare 远端、推好全部分支的本地仓库、「GitHub」克隆。每种层的组合在每个测试文件里只建一次，
 * 之后每个用例复制一份（copyRepo）再把 origin 指到自己的远端：建一次要十几个 git 进程，push / clone 自己还要再起
 * 好几个，Windows runner 上这些加起来是这个文件 30 秒超时的一大块（BTL-240）。
 */
function gitWorld(branches: readonly string[]) {
  const key = branches.join(",");
  let t = worldTemplates.get(key);
  if (!t) {
    const remote = tempDir("shipherd-remote-");
    g(remote, "init", "-q", "--bare", "-b", "main");
    const repo = makeRepo();
    g(repo, "remote", "add", "origin", remote);
    chain(repo, branches);
    // 一次推完：每次 push 都要起好几个进程，40 层的栈在 Windows 上一层一次推会慢很多。
    g(repo, "push", "-q", "origin", "main", ...branches);
    g(repo, "fetch", "-q", "origin");
    const hub = tempDir("shipherd-hub-");
    g(hub, "clone", "-q", remote, ".");
    g(hub, "config", "user.email", "hub@example.com");
    g(hub, "config", "user.name", "Hub");
    g(hub, "config", "commit.gpgsign", "false");
    t = { remote, repo, hub };
    worldTemplates.set(key, t);
  }
  const remote = copyRepo(t.remote, "shipherd-remote-");
  const repo = copyRepo(t.repo);
  const hub = copyRepo(t.hub, "shipherd-hub-");
  setOriginUrl(repo, remote);
  setOriginUrl(hub, remote);
  return { remote, repo, hub };
}

/** 4 层的栈 a ← b ← c ← d，每层一个提交、各改各的文件；全部推到远端。另有一个「GitHub」克隆用来合并。 */
function world(o: { mode?: StackRunMode; allow?: (k: ExternalActionKind, scope?: ExternalDetail["scope"]) => boolean; autoRebase?: boolean; policy?: Record<string, unknown>; branches?: string[] } = {}) {
  const branches = o.branches ?? BRANCHES;
  const { remote, repo, hub } = gitWorld(branches);

  const db = memDb();
  let clock = Date.parse("2026-11-18T10:00:00");
  const policy = new StackPolicyService({ db, productsOf: () => [], productName: () => null, now: () => clock });
  policy.setLayer({ kind: "global" }, { autoRebase: o.autoRebase ?? true, ...o.policy });
  const repoT = new StacksRepo(db, () => clock);
  const external: { kind: ExternalActionKind; detail: ExternalDetail; ran: boolean }[] = [];
  const allow = o.allow ?? (() => true);
  const delivered: { ticketKey: string; text: string }[] = [];
  const withdrawn: string[] = [];
  const posted: string[] = [];
  const deps: StackServiceDeps = {
    repo: repoT,
    policy,
    external: {
      async attempt<T>(kind: ExternalActionKind, detail: ExternalDetail, run: () => Promise<T>) {
        const ran = allow(kind, detail.scope);
        external.push({ kind, detail, ran });
        if (!ran) return { ran: false as const, auditId: 1 };
        return { ran: true as const, value: await run(), auditId: 1 };
      },
      allowed: (k, scope) => allow(k, scope),
    },
    workRoot: join(tempDir("shipherd-stackwork-"), "stack-work"),
    execPath: process.execPath,
    now: () => clock,
    log: () => undefined,
    owned: (_r, b) => (branches.includes(b) || b === "e" ? { ticketKey: b.toUpperCase(), ticketRepoId: 1, ticketTitle: `title ${b}`, worktree: null } : null),
    slugOf: async () => "acme/app",
    sessionBusy: () => false,
    gateHeld: () => false,
    trunkBusy: () => false,
    deliver: vi.fn(async (to: { ticketKey: string }, text: string) => (delivered.push({ ticketKey: to.ticketKey, text }), true)),
    withdraw: vi.fn((to: { ticketKey: string; branch: string }) => void withdrawn.push(`${to.ticketKey}:${to.branch}`)),
    briefProvider: (l) => ({ markdown: `<!-- shipherd:brief -->brief for ${l.branch}<!-- /shipherd:brief -->`, posted: (url) => posted.push(url) }),
    forceMode: o.mode,
  };
  const svc = new StackService(deps);
  return {
    repo, remote, hub, db, svc, deps, repoT, policy, external, delivered, withdrawn, posted,
    tip: (b: string) => g(repo, "rev-parse", b),
    remoteTip: (b: string) => g(remote, "rev-parse", b),
    /** 几个分支的提交，一个 git 进程。 */
    tips: (bs: readonly string[]) => g(repo, "rev-parse", ...bs).split(/\r?\n/),
    remoteTips: (bs: readonly string[]) => g(remote, "rev-parse", ...bs).split(/\r?\n/),
    advance: (ms: number) => (clock += ms),
    /** 在「GitHub」上把 a 合进 main。 */
    mergeOnHub(branch: string, how: "squash" | "merge") {
      g(hub, "fetch", "-q", "origin");
      g(hub, "checkout", "-q", "main");
      g(hub, "reset", "-q", "--hard", "origin/main");
      const head = g(hub, "rev-parse", `origin/${branch}`);
      if (how === "squash") {
        g(hub, "merge", "-q", "--squash", `origin/${branch}`);
        g(hub, "commit", "-q", "-m", `${branch} (squashed)`);
      } else {
        g(hub, "merge", "-q", "--no-ff", "-m", `Merge ${branch}`, `origin/${branch}`);
      }
      g(hub, "push", "-q", "origin", "main");
      return head;
    },
    /** 别人往 main 推了一个提交。 */
    pushMain(file: string, text: string) {
      g(hub, "fetch", "-q", "origin");
      g(hub, "checkout", "-q", "main");
      g(hub, "reset", "-q", "--hard", "origin/main");
      commit(hub, file, text, `main ${file}`);
      g(hub, "push", "-q", "origin", "main");
    },
  };
}

type World = ReturnType<typeof world>;

/**
 * 一条栈整体的形状：fetch 一次、git 两次（不随层数增长）。返回每层的 shape()（从 trunk 数起几个提交、是不是接在 trunk 上），
 * 前提是每层都是上一层（第一层是 origin/main）后面直接跟的单父提交；不是的层 count 记 -1、onTrunk 记 false。
 */
function chainShape(w: World, branches: readonly string[]) {
  g(w.repo, "fetch", "-q", "origin");
  const trunk = g(w.repo, "rev-parse", "origin/main");
  const tips = new Map(
    g(w.repo, "for-each-ref", "--format=%(refname:short) %(objectname)", ...branches.map((b) => `refs/heads/${b}`))
      .split("\n").map((l) => l.split(" ") as [string, string]),
  );
  const parents = new Map(
    g(w.repo, "rev-list", "--parents", ...branches.map((b) => tips.get(b) ?? b), "^origin/main")
      .split("\n").filter(Boolean).map((l) => { const [c, ...ps] = l.split(" "); return [c!, ps] as const; }),
  );
  let below = trunk;
  let count = 0;
  return branches.map((b) => {
    const tip = tips.get(b);
    const ps = tip === undefined ? undefined : parents.get(tip);
    if (count < 0 || tip === undefined || ps === undefined || ps.length !== 1 || ps[0] !== below) count = -1;
    else count++;
    below = tip ?? below;
    return count < 0 ? { count: -1, onTrunk: false } : { count, onTrunk: true };
  });
}

async function defineAll(w: World) {
  const r = await w.svc.define({ repoPath: w.repo, branches: BRANCHES, source: "mcp" });
  expect(r.ok).toBe(true);
  return r.stackId!;
}

/**
 * 每个分支从 trunk 起一共有几个提交、是不是直接接在 trunk 上。几个分支一起看只 fetch 一次：一次 fetch 自己还要起
 * upload-pack、pack-objects、rev-list 等好几个进程，Windows runner 上每个都不便宜（见文件头）。
 */
function shapes(w: World, branches: readonly string[]) {
  g(w.repo, "fetch", "-q", "origin");
  return branches.map((branch) => ({
    count: Number(g(w.repo, "rev-list", "--count", `origin/main..${branch}`)),
    onTrunk: (() => {
      try {
        g(w.repo, "merge-base", "--is-ancestor", "origin/main", branch);
        return true;
      } catch {
        return false;
      }
    })(),
  }));
}

function shape(w: World, branch: string) {
  return shapes(w, [branch])[0]!;
}

beforeEach(() => {
  fake.prs.clear();
  fake.issues.clear();
  fake.calls.length = 0;
  fake.next = 100;
});

describe("StackService.define", () => {
  it("records layers with their tips and bases", async () => {
    const w = world();
    const id = await defineAll(w);
    const layers = w.repoT.layers(id);
    expect(layers.map((l) => l.branch)).toEqual(BRANCHES);
    expect(layers[1]!.baseSha).toBe(w.tip("a"));
    expect(layers[3]!.tipSha).toBe(w.tip("d"));
    expect(w.repoT.get(id)).toMatchObject({ trunk: "main", remote: "origin", repoSlug: "acme/app", name: "A → B → C → D" });
  });

  it("refuses too few, foreign, duplicate and already-stacked branches", async () => {
    const w = world();
    expect((await w.svc.define({ repoPath: w.repo, branches: ["a"], source: "mcp" })).ok).toBe(false);
    expect((await w.svc.define({ repoPath: w.repo, branches: ["a", "main"], source: "mcp" })).ok).toBe(false);
    expect((await w.svc.define({ repoPath: w.repo, branches: ["a", "a"], source: "mcp" })).ok).toBe(false);
    await w.svc.define({ repoPath: w.repo, branches: ["a", "b"], source: "mcp" });
    expect((await w.svc.define({ repoPath: w.repo, branches: ["b", "c"], source: "mcp" })).ok).toBe(false);
  });

  it("stacks a new branch only on the top", async () => {
    const w = world();
    const r = await w.svc.define({ repoPath: w.repo, branches: ["a", "b"], source: "mcp" });
    expect(w.svc.canStackOn(w.repo, "a").ok).toBe(false);
    expect(w.svc.canStackOn(w.repo, "b").ok).toBe(true);
    g(w.repo, "branch", "e", "b");
    const s = await w.svc.stackOn({ repoPath: w.repo, parentBranch: "b", branch: "e", featureId: null });
    expect(s).toMatchObject({ ok: true, stackId: r.stackId });
    expect(w.repoT.layers(r.stackId!).map((l) => l.branch)).toEqual(["a", "b", "e"]);
  });

  it("detects chains of Shipherd PRs", async () => {
    const w = world();
    for (const [i, b] of BRANCHES.entries()) {
      fake.prs.set(10 + i, { number: 10 + i, url: `https://github.com/acme/app/pull/${10 + i}`, state: "OPEN", isDraft: i > 0, title: b, body: "", base: i ? BRANCHES[i - 1]! : "main", head: b, headSha: null, labels: [] });
    }
    const ids = await w.svc.detect(w.repo);
    expect(ids).toHaveLength(1);
    const layers = w.repoT.layers(ids[0]!);
    expect(layers.map((l) => [l.branch, l.prNumber, l.state])).toEqual([["a", 10, "ready"], ["b", 11, "draft"], ["c", 12, "draft"], ["d", 13, "draft"]]);
    expect(await w.svc.detect(w.repo)).toEqual([]);
    // 用户删掉的栈不会被自动检测建回来
    expect(w.svc.remove(ids[0]!).ok).toBe(true);
    expect(await w.svc.detect(w.repo)).toEqual([]);
  });

  it("detects stacks on tick in a repo of a semi epic even with autoRebase off everywhere (BTL-247)", async () => {
    const w = world({ autoRebase: false });
    for (const [i, b] of BRANCHES.entries()) {
      fake.prs.set(10 + i, { number: 10 + i, url: `https://github.com/acme/app/pull/${10 + i}`, state: "OPEN", isDraft: i > 0, title: b, body: "", base: i ? BRANCHES[i - 1]! : "main", head: b, headSha: null, labels: [] });
    }
    w.deps.repos = () => [w.repo];
    await w.svc.tick();
    expect(w.repoT.list()).toEqual([]);
    w.deps.autoRebaseRepos = () => [w.repo];
    w.advance(24 * 3_600_000);
    await w.svc.tick();
    expect(w.repoT.list()).toHaveLength(1);
  });
});

describe.each<[string, StackRunMode | undefined]>([["--update-refs", undefined], ["per-layer fallback", "per_layer"]])("bottom merged (%s)", (_n, mode) => {
  it.each(["squash", "merge"] as const)("rebases the top three layers after a %s merge and opens the new bottom as a ready PR", async (how) => {
    const w = world({ mode });
    const id = await defineAll(w);
    const head = w.mergeOnHub("a", how);
    const old = w.tips(["b", "c", "d"]);
    await w.svc.onMerged({ url: "https://github.com/acme/app/pull/1", number: 1, headSha: head, headBranch: "a" }, w.repo);

    expect(w.repoT.get(id)!.mergeMethod).toBe(how);
    expect(shapes(w, ["b", "c", "d"])).toEqual([1, 2, 3].map((count) => ({ count, onTrunk: true })));
    const now = w.tips(["b", "c", "d"]);
    for (const i of [0, 1, 2]) expect(now[i]).not.toBe(old[i]);
    expect(w.remoteTips(["b", "c", "d"])).toEqual(now);
    const run = w.repoT.lastRun(id)!;
    expect(run).toMatchObject({ trigger: "bottom_merged", outcome: "rebased" });
    expect(run.detail.mergeMethod).toBe(how);
    expect(run.detail.pushed).toEqual(["b", "c", "d"]);
    // 备份引用留着
    expect(w.tips(run.detail.layers!.map((l) => l.backupRef!))).toEqual(run.detail.layers!.map((l) => l.oldTip));
    expect(w.external.filter((e) => e.kind === "force_push").map((e) => e.detail.target)).toEqual(["b", "c", "d"]);

    const create = fake.calls.find((c) => c.fn === "prCreate")!.args[0] as CreatePr;
    expect(create).toMatchObject({ base: "main", head: "b", draft: false, title: "B title b" });
    expect(create.body.indexOf("brief for b")).toBeLessThan(create.body.indexOf("b one"));
    expect(w.posted).toEqual(["https://github.com/acme/app/pull/100"]);
    const layers = w.repoT.layers(id);
    expect(layers.map((l) => l.state)).toEqual(["merged", "ready", "branch_only", "branch_only"]);
    expect(layers[1]!.prNumber).toBe(100);
  });
});

describe("StackService depth", () => {
  it("has no layer limit: a 40-layer stack is defined, and after the bottom merges every layer above is rebased (workstream R, K8)", async () => {
    const branches = Array.from({ length: 40 }, (_, i) => `l${String(i).padStart(2, "0")}`);
    const w = world({ mode: "per_layer", branches });
    const r = await w.svc.define({ repoPath: w.repo, branches, source: "mcp" });
    expect(r.ok).toBe(true);
    const head = w.mergeOnHub(branches[0]!, "squash");
    await w.svc.onMerged({ url: "https://github.com/acme/app/pull/1", number: 1, headSha: head, headBranch: branches[0]! }, w.repo);
    expect(chainShape(w, branches.slice(1))).toEqual(branches.slice(1).map((_, i) => ({ count: i + 1, onTrunk: true })));
    expect(w.repoT.lastRun(r.stackId!)).toMatchObject({ trigger: "bottom_merged", outcome: "rebased" });
    // 39 层逐层 rebase，上千个 git 进程：Windows CI 上通常 70 秒左右，负载高时到过 135 秒（BTL-240）
  }, process.platform === "win32" ? 240_000 : 120_000);
});

describe("StackService bottom merged during a run", () => {
  it("waits for the run in flight instead of promoting an un-rebased layer", async () => {
    const w = world();
    const id = await defineAll(w);
    const head = w.mergeOnHub("a", "squash");
    // tick 的 rebase 正在跑（还没看到合并）时 PR 合并了
    const ticking = w.svc.rebaseNow(id);
    await w.svc.onMerged({ url: "https://github.com/acme/app/pull/1", number: 1, headSha: head, headBranch: "a" }, w.repo);
    await ticking;
    expect(shape(w, "b")).toEqual({ count: 1, onTrunk: true });
    // 合并后自己又跑了一次（正在跑的那次已经把 b 挪到了新的 main 上时是 noop），然后才开 PR
    const last = w.repoT.lastRun(id)!;
    expect(last.trigger).toBe("bottom_merged");
    expect(["rebased", "noop"]).toContain(last.outcome);
    const create = fake.calls.find((c) => c.fn === "prCreate")!.args[0] as CreatePr;
    expect(create).toMatchObject({ base: "main", head: "b" });
    expect(w.remoteTip("b")).toBe(w.tip("b"));
  });
});

describe("StackService draft layers", () => {
  it("opens drafts with the prefix, label and depends line, and promotes them when their turn comes", async () => {
    const w = world();
    const id = await defineAll(w);
    const [la, lb, lc] = w.repoT.layers(id);
    // 栈底开着 PR；b、c 开 draft
    fake.prs.set(1, { number: 1, url: "https://github.com/acme/app/pull/1", state: "OPEN", isDraft: false, title: "A", body: "", base: "main", head: "a", headSha: null, labels: [] });
    w.repoT.updateLayer(la!.id, { prNumber: 1, prUrl: "https://github.com/acme/app/pull/1", state: "ready" });
    expect((await w.svc.setLayerMode(la!.id, "draft")).ok).toBe(false);
    expect(await w.svc.setLayerMode(lb!.id, "draft")).toEqual({ ok: true });
    expect(await w.svc.setLayerMode(lc!.id, "draft")).toEqual({ ok: true });
    const b = fake.prs.get(100)!;
    expect(b).toMatchObject({ isDraft: true, base: "a", labels: ["stacked"] });
    expect(b.title).toMatch(/^\[stack 2\/4 · (勿 review|do not review)\] B title b$/);
    expect(b.body.split("\n")[0]).toMatch(/#1/);
    expect(fake.prs.get(101)!.body.split("\n")[0]).toMatch(/#100/);

    const head = w.mergeOnHub("a", "squash");
    await w.svc.onMerged({ url: "https://github.com/acme/app/pull/1", number: 1, headSha: head, headBranch: "a" }, w.repo);
    const nb = fake.prs.get(100)!;
    expect(nb).toMatchObject({ isDraft: false, base: "main", labels: [], title: "B title b" });
    expect(nb.body).toContain("brief for b");
    expect(nb.body.split("\n")[0]).not.toMatch(/#1\b/);
    expect(w.repoT.layer(lb!.id)).toMatchObject({ state: "ready", mode: "branch", draftSince: null });
    // c 仍是 draft，k/n 和依赖行跟着变：现在是 3/4，依赖 #100
    expect(fake.prs.get(101)!.title).toMatch(/^\[stack 3\/4 /);
    expect(fake.prs.get(101)!.body.split("\n")[0]).toMatch(/#100/);
  });

  it("demotes a draft back to a plain branch", async () => {
    const w = world();
    const id = await defineAll(w);
    const lc = w.repoT.layers(id)[2]!;
    await w.svc.setLayerMode(lc.id, "draft");
    expect(await w.svc.setLayerMode(lc.id, "branch")).toEqual({ ok: true });
    expect(fake.prs.get(100)!.state).toBe("CLOSED");
    expect(w.repoT.layer(lc.id)).toMatchObject({ mode: "branch", state: "branch_only", prNumber: null });
  });

  it("marks the draft it closed as closed by Shipherd, and only when it really closed it (BTL-270)", async () => {
    const w = world();
    const closed: string[] = [];
    w.deps.closedByShipherd = (url) => closed.push(url);
    const id = await defineAll(w);
    const lc = w.repoT.layers(id)[2]!;
    await w.svc.setLayerMode(lc.id, "draft");
    const url = w.repoT.layer(lc.id)!.prUrl;
    expect(url).toMatch(/\/pull\/100$/);
    await w.svc.setLayerMode(lc.id, "branch");
    expect(closed).toEqual([url]);

    // 对外动作开关关着、没关成：不记。
    let allowClose = true;
    const w2 = world({ allow: (k) => k !== "pr_open" || allowClose });
    const closed2: string[] = [];
    w2.deps.closedByShipherd = (u) => closed2.push(u);
    const id2 = await defineAll(w2);
    const l2 = w2.repoT.layers(id2)[2]!;
    await w2.svc.setLayerMode(l2.id, "draft");
    allowClose = false;
    expect((await w2.svc.setLayerMode(l2.id, "branch")).ok).toBe(false);
    expect(closed2).toEqual([]);
  });

  it("reminds about stale drafts", async () => {
    const w = world();
    const id = await defineAll(w);
    await w.svc.setLayerMode(w.repoT.layers(id)[2]!.id, "draft");
    expect(w.svc.notices().filter((n) => n.reason === "draft_stale")).toEqual([]);
    w.advance(15 * 24 * 3600_000);
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "draft_stale", branch: "c", days: 15, prNumber: 100, ticketKey: "C" }));
  });
});

describe("StackService switches", () => {
  it("does not touch branches with autoRebase off", async () => {
    const w = world({ autoRebase: false });
    const id = await defineAll(w);
    const before = w.tips(BRANCHES);
    expect((await w.svc.rebaseNow(id)).ok).toBe(false);
    const head = w.mergeOnHub("a", "squash");
    await w.svc.onMerged({ url: "u1", number: 1, headSha: head, headBranch: "a" }, w.repo);
    w.pushMain("m.txt", "m\n");
    w.advance(10 * 60_000);
    await w.svc.tick();
    expect(w.tips(BRANCHES)).toEqual(before);
    expect(w.repoT.layers(id)[0]!.state).toBe("merged");
    expect(w.external.filter((e) => e.kind === "force_push")).toEqual([]);
  });

  it("lets an epic's own automation level decide autoRebase from the unmerged layers' tickets (BTL-247)", async () => {
    const w = world({ autoRebase: false });
    const id = await defineAll(w);
    const seen: (string | null)[][] = [];
    let level: "semi" | "manual" | null = "semi";
    w.deps.overlay = (base, keys) => (seen.push(keys), level === null ? base : { ...base, autoRebase: level === "semi" });
    expect(w.svc.policyOf(w.repoT.get(id)!).autoRebase).toBe(true);
    expect(seen.at(-1)).toEqual(["A", "B", "C", "D"]);
    level = "manual";
    expect(w.svc.policyOf(w.repoT.get(id)!).autoRebase).toBe(false);
    w.deps.overlay = () => {
      throw new Error("boom");
    };
    expect(w.svc.policyOf(w.repoT.get(id)!).autoRebase).toBe(false);
  });

  it("rebases locally but neither pushes nor opens PRs with the outward switches off, then catches up", async () => {
    let on = false;
    const w = world({ allow: () => on });
    const id = await defineAll(w);
    const oldRemote = w.remoteTip("b");
    const head = w.mergeOnHub("a", "squash");
    await w.svc.onMerged({ url: "u1", number: 1, headSha: head, headBranch: "a" }, w.repo);
    expect(shape(w, "b")).toEqual({ count: 1, onTrunk: true });
    expect(w.remoteTip("b")).toBe(oldRemote);
    expect(fake.calls.filter((c) => c.fn === "prCreate")).toEqual([]);
    const lr = w.repoT.lastRun(id)!;
    expect(lr.detail.unpushed).toEqual(["b", "c", "d"]);
    expect(w.repoT.layers(id)[1]).toMatchObject({ state: "branch_only", remoteOkSha: oldRemote });
    // 再改一次（layer_commits）：远端还停在 Shipherd 上次替换掉的提交，照样能改
    g(w.repo, "checkout", "-q", "c");
    commit(w.repo, "c2.txt", "c2\n", "c two");
    g(w.repo, "checkout", "-q", "main");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "layer_commits", outcome: "rebased" });
    // 开关打开后：下一次跑会推上去，再开 PR
    on = true;
    await w.svc.rebaseNow(id);
    await w.svc.tick();
    expect(w.remoteTip("b")).toBe(w.tip("b"));
    expect(fake.calls.filter((c) => c.fn === "prCreate")).toHaveLength(1);
  });
});

describe("StackService per-ticket switches (BTL-247)", () => {
  it("catches up pushes and the bottom PR when only the layers' tickets are allowed", async () => {
    let on = false;
    // 全局关着；只有带 ticket 的判断（epic 档位盖上去的）放行。
    const w = world({ policy: { dailyRebase: false }, allow: (_k, scope) => on && !!scope?.ticketKey });
    const id = await defineAll(w);
    const oldRemote = w.remoteTip("b");
    const head = w.mergeOnHub("a", "squash");
    await w.svc.onMerged({ url: "u1", number: 1, headSha: head, headBranch: "a" }, w.repo);
    expect(w.remoteTip("b")).toBe(oldRemote);
    expect(fake.calls.filter((c) => c.fn === "prCreate")).toEqual([]);
    on = true;
    w.advance(10 * 60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)?.trigger).toBe("bottom_merged");
    expect(w.remoteTip("b")).toBe(w.tip("b"));
    expect(fake.calls.filter((c) => c.fn === "prCreate")).toHaveLength(1);
  });
});

describe("StackService triggers", () => {
  it("rebases the whole stack once a day and keeps it current", async () => {
    const w = world({ policy: { rebaseOnMainUpdate: false } });
    const id = await defineAll(w);
    await w.svc.tick(); // 今天的第一次：没东西可做
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "daily", outcome: "noop" });
    w.pushMain("m.txt", "m\n");
    w.advance(10 * 60_000);
    await w.svc.tick();
    expect(shape(w, "a")).toEqual({ count: 1, onTrunk: false }); // 同一天不再跑
    w.advance(24 * 3600_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "daily", outcome: "rebased" });
    expect(shapes(w, BRANCHES)).toEqual([1, 2, 3, 4].map((count) => ({ count, onTrunk: true })));
  });

  it("follows main when it moves", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.pushMain("m.txt", "m\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "main_updated", outcome: "rebased" });
    expect(shape(w, "d")).toEqual({ count: 4, onTrunk: true });
  });

  it("fetches and adds its temporary worktree only while holding the repo lock (BTL-264)", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.pushMain("m.txt", "m\n");
    let release: (() => void) | undefined;
    const held = repoLocks.run(await repoLockKey(w.repo), () => new Promise<void>((r) => (release = r)), "test holder");
    while (!release) await new Promise((r) => setImmediate(r));
    let finished = false;
    const t = w.svc.tick().then(() => (finished = true));
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
    expect(finished).toBe(false);
    expect(w.repoT.lastRun(id)?.trigger).not.toBe("main_updated");
    release();
    await held;
    await t;
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "main_updated", outcome: "rebased" });
  });

  it("defers when a layer is checked out somewhere Shipherd does not manage and collapses repeats", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    const wt = join(tempDir(), "wt");
    g(w.repo, "worktree", "add", "-q", wt, "c");
    const before = w.tips(BRANCHES);
    w.pushMain("m.txt", "m\n");
    await w.svc.tick();
    await w.svc.rebaseNow(id);
    expect(w.tips(BRANCHES)).toEqual(before);
    const runs = w.repoT.runs(id);
    expect(runs[0]).toMatchObject({ outcome: "deferred" });
    expect(runs[0]!.detail.repeats).toBe(2);
    expect(runs.filter((r) => r.outcome === "deferred")).toHaveLength(1);
    w.advance(25 * 3600_000);
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "stuck", branch: "a" }));
  });

  it("defers while review comments are being checked or the merge gate is held", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.deps.gateHeld = (_r, b) => b === "b";
    w.pushMain("m.txt", "m\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred" });
    expect(w.repoT.lastRun(id)!.reason).toMatch(/merge gate/);
  });

  it("sends a conflict to that layer's session once and leaves every branch alone", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.pushMain("b.txt", "main's b\n");
    const before = w.tips(BRANCHES);
    await w.svc.tick();
    expect(w.tips(BRANCHES)).toEqual(before);
    const run = w.repoT.lastRun(id)!;
    expect(run).toMatchObject({ outcome: "conflict" });
    expect(run.detail.conflict).toMatchObject({ branch: "b", files: ["b.txt"] });
    expect(w.delivered).toHaveLength(1);
    expect(w.delivered[0]!.ticketKey).toBe("B");
    expect(w.delivered[0]!.text).toContain("git rebase --onto");
    await w.svc.rebaseNow(id);
    expect(w.delivered).toHaveLength(1);
    expect(w.svc.notices().filter((n) => n.reason === "conflict")).toEqual([]);
    expect(g(w.repo, "for-each-ref", "refs/heads/shipherd-stack/")).toBe("");
    expect(g(w.repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("after the session follows the conflict instructions, the next run carries on from its resolution", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.pushMain("b.txt", "main's b\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "conflict" });
    const cmd = /git rebase --onto (\S+) (\S+)/.exec(w.delivered[0]!.text)!;
    // session 在自己的 worktree 里照做、解决冲突（这里做完把 worktree 拿掉，免得算成 Shipherd 不管的检出）
    const wt = join(tempDir(), "wt-b");
    g(w.repo, "worktree", "add", "-q", wt, "b");
    try {
      g(wt, "rebase", "-q", "--onto", cmd[1]!, cmd[2]!);
    } catch {
      writeFileSync(join(wt, "b.txt"), "b\n");
      g(wt, "add", "b.txt");
      execFileSync("git", ["rebase", "--continue"], { cwd: wt, stdio: "ignore", env: { ...process.env, GIT_EDITOR: "true" } });
    }
    g(wt, "push", "-q", "--force-with-lease", "origin", "b");
    g(w.repo, "worktree", "remove", "--force", wt);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "layer_commits", outcome: "rebased" });
    expect(shapes(w, ["b", "c", "d"])).toEqual([2, 3, 4].map((count) => ({ count, onTrunk: true })));
    expect(w.repoT.layers(id).map((l) => l.conflictKey)).toEqual([null, null, null, null]);
    expect(w.svc.notices().filter((n) => n.reason === "conflict")).toEqual([]);
    // 两次整栈 rebase 加一次解冲突，全是真 git 调用：Windows CI 上贴着 30 秒的默认上限，放宽到 120 秒
  }, 120_000);

  it("tells the session not to push when Force push is off", async () => {
    const w = world({ policy: { dailyRebase: false }, allow: (k) => k !== "force_push" });
    await defineAll(w);
    w.pushMain("b.txt", "main's b\n");
    await w.svc.tick();
    expect(w.delivered[0]!.text).not.toContain("git push");
  });

  it("shows the conflict on the Now page when it should not go to the session", async () => {
    const w = world({ policy: { dailyRebase: false, conflictToSession: false } });
    await defineAll(w);
    w.pushMain("b.txt", "main's b\n");
    await w.svc.tick();
    expect(w.delivered).toEqual([]);
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "conflict", branch: "b", files: ["b.txt"], ticketKey: "B" }));
  });

  it("warns when the bottom falls behind main", async () => {
    const w = world({ autoRebase: false, policy: { behindCommits: 2 } });
    await defineAll(w);
    for (const f of ["x", "y", "z"]) w.pushMain(`${f}.txt`, `${f}\n`);
    await w.svc.tick();
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "behind", branch: "a", commits: 3 }));
  });

  it("folds fixup commits in with autosquash", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    await w.svc.tick();
    g(w.repo, "checkout", "-q", "b");
    commit(w.repo, "b-fix.txt", "fix\n", "fixup! b one");
    g(w.repo, "checkout", "-q", "main");
    await w.svc.tick(); // layer_commits：b 有新提交，先把上面的层接上去
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "layer_commits", outcome: "rebased" });
    await w.svc.tick(); // 栈是新的、有 fixup：autosquash
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "autosquash", outcome: "rebased" });
    expect(g(w.repo, "log", "--format=%s", "main..b")).toBe("b one\na one");
    expect(g(w.repo, "log", "--format=%s", "main..d")).toBe("d one\nc one\nb one\na one");
  });

  it("tries an autosquash that changes nothing only once", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    await w.svc.tick();
    g(w.repo, "checkout", "-q", "b");
    commit(w.repo, "b-fix.txt", "fix\n", "fixup! something outside the stack");
    g(w.repo, "checkout", "-q", "main");
    for (let n = 0; n < 4; n++) await w.svc.tick();
    expect(w.repoT.runs(id, 50).filter((r) => r.trigger === "autosquash")).toHaveLength(1);
  });

  it("does not autosquash while comments are being checked", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.repoT.updateLayer(w.repoT.layers(id)[1]!.id, { prUrl: "pr-b" });
    w.deps.awaitingCheck = (u) => u === "pr-b";
    g(w.repo, "checkout", "-q", "b");
    commit(w.repo, "b-fix.txt", "fix\n", "fixup! b one");
    g(w.repo, "checkout", "-q", "main");
    await w.svc.tick();
    await w.svc.tick();
    expect(g(w.repo, "log", "--format=%s", "main..b")).toBe("fixup! b one\nb one\na one");
  });
});

describe("StackService restore", () => {
  it("puts every branch back from the backups of the last rebase", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    const before = w.tips(BRANCHES);
    w.pushMain("m.txt", "m\n");
    await w.svc.tick();
    expect(w.tips(BRANCHES)).not.toEqual(before);
    expect(await w.svc.restore(id)).toEqual({ ok: true });
    expect(w.tips(BRANCHES)).toEqual(before);
    expect(BRANCHES.map(w.remoteTip)).toEqual(before);
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "restore", outcome: "restored" });
    expect((await w.svc.restore(id)).ok).toBe(false);
  });

  it("deletes backups after 30 days", async () => {
    const w = world({ policy: { dailyRebase: false } });
    await defineAll(w);
    w.pushMain("m.txt", "m\n");
    await w.svc.tick();
    expect(g(w.repo, "for-each-ref", "refs/shipherd/stack-backup/")).not.toBe("");
    w.advance(31 * 24 * 3600_000);
    await w.svc.daily();
    expect(g(w.repo, "for-each-ref", "refs/shipherd/stack-backup/")).toBe("");
  });

  it("runs the daily job once a day and retries a failure after 30 minutes", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const jobs = new JobsRepo(w.db);
    w.deps.jobs = jobs;
    const daily = vi.spyOn(w.svc, "daily");
    expect(await w.svc.dailyJob()).toBe(true);
    expect(await w.svc.dailyJob()).toBe(false);
    expect(jobs.get(JOB_STACKS_DAILY).lastStatus).toBe("ok");
    w.advance(24 * 3600_000);
    daily.mockRejectedValueOnce(new Error("boom"));
    expect(await w.svc.dailyJob()).toBe(true);
    expect(jobs.get(JOB_STACKS_DAILY)).toMatchObject({ lastStatus: "failed", lastError: "boom" });
    w.advance(10 * 60_000);
    expect(await w.svc.dailyJob()).toBe(false);
    w.advance(25 * 60_000);
    expect(await w.svc.dailyJob()).toBe(true);
    expect(daily).toHaveBeenCalledTimes(3);
  });
});

describe("StackService for other workstreams", () => {
  it("adds a stack note to review comments on a layer", async () => {
    const w = world();
    const id = await defineAll(w);
    w.repoT.updateLayer(w.repoT.layers(id)[1]!.id, { prUrl: "https://github.com/acme/app/pull/7", prNumber: 7 });
    const note = w.svc.stackNote("https://github.com/acme/app/pull/7", "b");
    expect(note).toMatch(/2\/4/);
    expect(note).toContain("--fixup");
    expect(w.svc.stackNote("https://github.com/acme/app/pull/9", "zzz")).toBeNull();
  });

  it("stackBelow names the nearest unmerged layer below, for the turn board (UI redesign layer 1)", async () => {
    const w = world();
    const id = await defineAll(w);
    const layers = w.repoT.layers(id);
    w.repoT.updateLayer(layers[2]!.id, { prUrl: "https://github.com/acme/app/pull/8", prNumber: 8 });
    expect(w.svc.stackBelow("https://github.com/Acme/App/pull/8", layers[2]!.branch)).toBe(layers[1]!.branch);
    w.repoT.updateLayer(layers[1]!.id, { state: "merged" });
    expect(w.svc.stackBelow("https://github.com/acme/app/pull/8", layers[2]!.branch)).toBe(layers[0]!.branch);
    w.repoT.updateLayer(layers[0]!.id, { state: "merged" });
    expect(w.svc.stackBelow("https://github.com/acme/app/pull/8", layers[2]!.branch)).toBeNull();
    expect(w.svc.stackBelow("https://github.com/acme/app/pull/1", layers[0]!.branch)).toBeNull();
    expect(w.svc.stackBelow("https://github.com/acme/app/pull/9", "zzz")).toBeNull();
  });

  it("stackBelow by branch name alone only matches a layer with no PR yet, in the same repo", async () => {
    const w = world();
    const id = await defineAll(w);
    const layers = w.repoT.layers(id);
    // 还没记 PR 的层：同仓库按分支兜底
    expect(w.svc.stackBelow("https://github.com/acme/app/pull/8", layers[2]!.branch)).toBe(layers[1]!.branch);
    // 多仓库 ticket 在别的仓库起了同名分支：不在栈里
    expect(w.svc.stackBelow("https://github.com/acme/other/pull/3", layers[2]!.branch)).toBeNull();
    // 这一层已经记了别的 PR：同名分支的另一个 PR 不是它
    w.repoT.updateLayer(layers[2]!.id, { prUrl: "https://github.com/acme/app/pull/8", prNumber: 8 });
    expect(w.svc.stackBelow("https://github.com/acme/app/pull/30", layers[2]!.branch)).toBeNull();
  });

  it("posts the stack overview as an issue only when asked to", async () => {
    const w = world({ policy: { overview: "issue", dailyRebase: false } });
    await defineAll(w);
    await w.svc.tick();
    expect(fake.calls.filter((c) => c.fn === "issueCreate")).toHaveLength(1);
    await w.svc.tick();
    expect(fake.calls.filter((c) => c.fn.startsWith("issue"))).toHaveLength(1);
  });

  it("builds the progress view", async () => {
    const w = world();
    const id = await defineAll(w);
    const v = await w.svc.view({ featureId: null });
    expect(v.stacks).toHaveLength(1);
    expect(v.stacks[0]).toMatchObject({ id, autoRebase: true, layers: [{ branch: "a", ticketTitle: "title a" }, {}, {}, {}] });
  });
});

/**
 * 空闲时栈 tick 的开销（BTL-275 基准，只在 SHIPHERD_PERF_BENCH=1 时跑）：栈什么都没变，每分钟一次 tick，
 * 发了几次 onChange（每次都是整个界面重取）、起了几个 git、每次多久。git 经一个包装脚本数次数。
 */
/** 数这之后起了几个 git（换成一个记次数的包装脚本）。只在非 Windows 上用。 */
async function countGits(): Promise<{ n: () => number; done: () => void }> {
  const { setGitBinary, resetGitBinary } = await import("../util/git-path");
  const dir = tempDir("shipherd-gitcount-");
  const log = join(dir, "calls");
  const wrapper = join(dir, "git");
  writeFileSync(log, "");
  writeFileSync(wrapper, `#!/bin/sh\necho x >> "${log}"\nexec /usr/bin/env git "$@"\n`, { mode: 0o755 });
  setGitBinary(wrapper);
  const { readFileSync } = await import("node:fs");
  return { n: () => readFileSync(log, "utf8").split("\n").filter(Boolean).length, done: resetGitBinary };
}

/** 「GitHub」上开着的一个 PR（openPrs、prView 都看得到）。 */
function openPr(n: number, head: string, base: string, draft: boolean): PrSnapshot {
  const p: PrSnapshot = { number: n, url: `https://github.com/acme/app/pull/${n}`, state: "OPEN", isDraft: draft, title: `PR ${n}`, body: "", base, head, headSha: null, labels: [] };
  fake.prs.set(n, p);
  return p;
}

describe("StackService guards before rewriting branches (BTL-278)", () => {
  it.each(["mcp", "ticket", "detected"] as const)("reads the open review PR of a %s stack and asks before rewriting that layer", async (source) => {
    const w = world({ policy: { dailyRebase: false } });
    openPr(1, "a", "main", false);
    let id: number;
    if (source === "detected") {
      openPr(2, "b", "a", true);
      id = (await w.svc.detect(w.repo))[0]!;
    } else if (source === "ticket") {
      id = (await w.svc.stackOn({ repoPath: w.repo, parentBranch: "a", branch: "b", featureId: null })).stackId!;
    } else {
      id = (await w.svc.define({ repoPath: w.repo, branches: ["a", "b"], source: "mcp" })).stackId!;
    }
    expect(w.repoT.layers(id)[0]).toMatchObject({ state: "ready", mode: "branch", prNumber: 1 });
    w.pushMain("x.txt", "x\n");
    const local = w.tips(["a", "b"]);
    const remote = w.remoteTips(["a", "b"]);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "needs_confirm" });
    expect(w.tips(["a", "b"])).toEqual(local);
    expect(w.remoteTips(["a", "b"])).toEqual(remote);
    expect(w.external.filter((e) => e.kind === "force_push")).toEqual([]);
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "confirm", branch: "a", prNumber: 1, detail: "ready_pr" }));
    // 不每分钟再问一次
    for (let n = 0; n < 3; n++) {
      w.advance(5 * 60_000);
      await w.svc.tick();
    }
    expect(w.repoT.runs(id, 10)).toHaveLength(1);
    // 用户确认：手动 rebase 才改写、推上去
    expect((await w.svc.rebaseNow(id)).ok).toBe(true);
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "manual", outcome: "rebased" });
    expect(w.remoteTips(["a", "b"])).toEqual(w.tips(["a", "b"]));
    expect(w.svc.notices().filter((n) => n.reason === "confirm")).toEqual([]);
  });

  it("records who confirmed: a click in the app or the coordinator's stack_rebase", async () => {
    const w = world({ policy: { dailyRebase: false } });
    openPr(1, "a", "main", false);
    const id = (await w.svc.define({ repoPath: w.repo, branches: ["a", "b"], source: "mcp" })).stackId!;
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    const asked = w.repoT.lastRun(id)!;
    expect(asked.outcome).toBe("needs_confirm");
    expect((await w.svc.rebaseNow(id, "coordinator")).ok).toBe(true);
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "manual", outcome: "rebased", detail: { actor: "coordinator", confirms: asked.id } });
    // 没有等确认的时候点「马上 rebase」：记下是谁点的，但不算确认了什么
    w.pushMain("y.txt", "y\n");
    expect((await w.svc.rebaseNow(id)).ok).toBe(true);
    expect(w.repoT.lastRun(id)!.detail).toMatchObject({ actor: "user" });
    expect(w.repoT.lastRun(id)!.detail.confirms).toBeUndefined();
  });

  it("drops the confirm notice once the layer is no longer under review, and the next auto run goes ahead", async () => {
    const w = world({ policy: { dailyRebase: false } });
    openPr(1, "a", "main", false);
    const id = (await w.svc.define({ repoPath: w.repo, branches: ["a", "b"], source: "mcp" })).stackId!;
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "confirm" }));
    // PR 转回 draft：读到的层状态变了
    fake.prs.get(1)!.isDraft = true;
    await w.svc.detect(w.repo);
    expect(w.repoT.layers(id)[0]!.state).toBe("draft");
    expect(w.svc.notices().filter((n) => n.reason === "confirm")).toEqual([]);
    w.advance(5 * 60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    expect(w.remoteTips(["a", "b"])).toEqual(w.tips(["a", "b"]));
  });

  it("a manual confirm still runs the checks before the force push", async () => {
    const w = world({ policy: { dailyRebase: false } });
    openPr(1, "a", "main", false);
    const id = (await w.svc.define({ repoPath: w.repo, branches: ["a", "b"], source: "mcp" })).stackId!;
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)!.outcome).toBe("needs_confirm");
    // GitHub 读不到：手动也不改写
    const gh = await import("./gh-stack");
    vi.mocked(gh.openPrs).mockResolvedValueOnce(null);
    const local = w.tips(["a", "b"]);
    const remote = w.remoteTips(["a", "b"]);
    await w.svc.rebaseNow(id);
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "manual", outcome: "deferred", reason: "can't read the open PRs" });
    expect(w.tips(["a", "b"])).toEqual(local);
    expect(w.remoteTips(["a", "b"])).toEqual(remote);
    // 别人刚往 a 的 PR 推了一个提交：手动确认也不能盖掉它
    g(w.hub, "fetch", "-q", "origin");
    g(w.hub, "checkout", "-q", "-B", "a", "origin/a");
    g(w.hub, "commit", "-q", "--allow-empty", "-m", "reviewer fix");
    g(w.hub, "push", "-q", "origin", "a");
    const theirs = w.remoteTip("a");
    await w.svc.rebaseNow(id);
    expect(w.remoteTip("a")).toBe(theirs);
    expect(w.repoT.lastRun(id)!.outcome).not.toBe("rebased");
  });

  it("finds the layer's PR even when the repo has more open PRs than one page holds", async () => {
    const w = world({ policy: { dailyRebase: false } });
    openPr(1, "a", "main", false);
    for (let n = 0; n < 200; n++) openPr(1000 + n, `other-${n}`, "main", false);
    const id = (await w.svc.define({ repoPath: w.repo, branches: ["a", "b"], source: "mcp" })).stackId!;
    expect(w.repoT.layers(id)[0]).toMatchObject({ state: "ready", prNumber: 1 });
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "needs_confirm" });
    // 逐层查也查不到：不改写
    const gh = await import("./gh-stack");
    vi.mocked(gh.openPrsForHeads).mockResolvedValueOnce(null);
    w.pushMain("y.txt", "y\n");
    w.advance(5 * 60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred", reason: "can't read the open PRs" });
  });

  it("asks before handing a conflict on a layer under review to its session", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    openPr(2, "b", "a", false);
    w.pushMain("b.txt", "main's b\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "needs_confirm", detail: { confirm: { why: "ready_pr" } } });
    expect(w.repoT.lastRun(id)!.detail.confirm!.branches).toContain("b");
    expect(w.delivered).toEqual([]);
    expect(w.repoT.layers(id)[1]!.conflictKey).toBeNull();
    // 确认了就交给 session
    await w.svc.rebaseNow(id);
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "manual", outcome: "conflict" });
    expect(w.delivered).toHaveLength(1);
  });

  it("asks before handing a conflict over when a ready layer below it is rewritten", async () => {
    const w = world({ policy: { dailyRebase: false } });
    openPr(1, "a", "main", false);
    const id = await defineAll(w);
    expect(w.repoT.layers(id)[0]).toMatchObject({ state: "ready", prNumber: 1 });
    // main 动了：a 被挪到新 main 上（要改写），b 冲突
    w.pushMain("b.txt", "main's b\n");
    const remote = w.remoteTips(BRANCHES);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "needs_confirm", detail: { confirm: { why: "ready_pr" } } });
    expect(w.repoT.lastRun(id)!.detail.confirm!.branches).toContain("a");
    expect(w.delivered).toEqual([]);
    expect(w.remoteTips(BRANCHES)).toEqual(remote);
  });

  it("hands a conflict to its session when the ready layer below it is not rewritten", async () => {
    const w = world({ policy: { dailyRebase: false } });
    openPr(1, "a", "main", false);
    const id = await defineAll(w);
    expect(w.repoT.layers(id)[0]).toMatchObject({ state: "ready", prNumber: 1 });
    // a 的作者推了 review 修改（a 还在 main 上），b 叠上去冲突：a 不会被改写，冲突直接交给 b
    g(w.repo, "checkout", "-q", "a");
    commit(w.repo, "b.txt", "a's b\n", "a review fix");
    g(w.repo, "checkout", "-q", "--detach");
    const a = w.tip("a");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "conflict", detail: { conflict: { branch: "b" } } });
    expect(w.delivered.map((d) => d.ticketKey)).toEqual(["B"]);
    expect(w.tip("a")).toBe(a);
  });

  it("retries a failed run after a while even when nothing changed (a git timeout is not a verdict)", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.pushMain("x.txt", "x\n");
    g(w.repo, "fetch", "-q", "origin");
    const stack = w.repoT.get(id)!;
    const inputs = await (w.svc as unknown as { inputsOf(s: typeof stack): Promise<string> }).inputsOf(stack);
    const runId = w.repoT.startRun(id, "main_updated", "update_refs");
    w.repoT.finishRun(runId, { outcome: "failed", reason: "git rebase timed out", detail: { inputs } });
    await w.svc.tick();
    expect(w.repoT.lastRun(id)!.id).toBe(runId);
    w.advance(61 * 60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
  });

  it("backs off when the same failure repeats on the same inputs", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.pushMain("x.txt", "x\n");
    g(w.repo, "fetch", "-q", "origin");
    const stack = w.repoT.get(id)!;
    const inputs = await (w.svc as unknown as { inputsOf(s: typeof stack): Promise<string> }).inputsOf(stack);
    for (let n = 0; n < 2; n++) {
      const r = w.repoT.startRun(id, "main_updated", "update_refs");
      w.repoT.finishRun(r, { outcome: "failed", reason: "conflict markers left in a.txt", detail: { inputs } });
    }
    const last = w.repoT.lastRun(id)!.id;
    // 连着两次：等两小时
    w.advance(61 * 60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)!.id).toBe(last);
    w.advance(60 * 60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
  });

  it("caps the back-off at a day, and starts over at an hour when the failure changes", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.pushMain("x.txt", "x\n");
    g(w.repo, "fetch", "-q", "origin");
    const stack = w.repoT.get(id)!;
    const inputs = await (w.svc as unknown as { inputsOf(s: typeof stack): Promise<string> }).inputsOf(stack);
    const fail = (reason: string): number => {
      const r = w.repoT.startRun(id, "main_updated", "update_refs");
      w.repoT.finishRun(r, { outcome: "failed", reason, detail: { inputs } });
      return r;
    };
    // 同一个原因连着 8 次（2^7 小时远超一天）：等满一天就重试；原因里的 run 目录号不同也算同一个原因
    for (let n = 0; n < 8; n++) fail(`git worktree add failed: /tmp/work/run-${100 + n} already exists`);
    let last = w.repoT.lastRun(id)!.id;
    w.advance(23 * 3600_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)!.id).toBe(last);
    w.advance(3600_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    // 换了原因：从一小时重新算
    w.pushMain("y.txt", "y\n");
    g(w.repo, "fetch", "-q", "origin");
    // 和上面一样让下一次 tick 去对 trunk（fetch 已经手动做过）
    w.repoT.updateStack(id, { trunkSha: null });
    const s2 = w.repoT.get(id)!;
    const inputs2 = await (w.svc as unknown as { inputsOf(s: typeof s2): Promise<string> }).inputsOf(s2);
    for (const reason of ["git rebase timed out", "git rebase timed out", "conflict markers left in a.txt"]) {
      const r = w.repoT.startRun(id, "main_updated", "update_refs");
      w.repoT.finishRun(r, { outcome: "failed", reason, detail: { inputs: inputs2 } });
    }
    last = w.repoT.lastRun(id)!.id;
    w.advance(59 * 60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)!.id).toBe(last);
    w.advance(2 * 60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
  });

  it.each([
    ["a github.com remote", true],
    ["a remote on another host", false],
  ])("without a known slug, an unreadable PR list on %s defers: %s", async (_label, github) => {
    const w = world({ policy: { dailyRebase: false } });
    w.deps.slugOf = async () => null;
    if (github) {
      // remote 写成 github.com 的地址，git 照旧走本地的 bare 仓库
      g(w.repo, "remote", "set-url", "origin", "https://github.com/acme/app.git");
      g(w.repo, "config", `url.${w.remote}.insteadOf`, "https://github.com/acme/app.git");
    }
    const gh = await import("./gh-stack");
    const impl = vi.mocked(gh.openPrs).getMockImplementation()!;
    vi.mocked(gh.openPrs).mockResolvedValue(null);
    try {
      const id = await defineAll(w);
      w.pushMain("x.txt", "x\n");
      await w.svc.tick();
      if (github) expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred", reason: "can't read the open PRs" });
      else expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    } finally {
      vi.mocked(gh.openPrs).mockImplementation(impl);
    }
  });

  it("reads the PR of a layer added to an existing stack", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = (await w.svc.define({ repoPath: w.repo, branches: ["a", "b"], source: "mcp" })).stackId!;
    openPr(3, "c", "b", false);
    const r = await w.svc.stackOn({ repoPath: w.repo, parentBranch: "b", branch: "c", featureId: null });
    expect(r.stackId).toBe(id);
    expect(w.repoT.layers(id).find((l) => l.branch === "c")).toMatchObject({ state: "ready", prNumber: 3 });
  });

  it("reads a PR opened after the stack was defined before pushing anything", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    expect(w.repoT.layers(id).map((l) => l.state)).toEqual(["branch_only", "branch_only", "branch_only", "branch_only"]);
    openPr(7, "b", "a", false);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.repoT.layers(id)[1]).toMatchObject({ state: "ready", prNumber: 7, prUrl: "https://github.com/acme/app/pull/7" });
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "needs_confirm" });
    expect(w.external.filter((e) => e.kind === "force_push")).toEqual([]);
  });

  it("fills in a missing repo slug before reading PRs, and defers an auto run when GitHub can't be read", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.repoT.updateStack(id, { repoSlug: null });
    openPr(1, "a", "main", false);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.repoT.get(id)!.repoSlug).toBe("acme/app");
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "needs_confirm" });
    const gh = await import("./gh-stack");
    vi.mocked(gh.openPrs).mockResolvedValueOnce(null);
    w.pushMain("y.txt", "y\n");
    w.advance(5 * 60_000);
    const remote = w.remoteTips(BRANCHES);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred", reason: "can't read the open PRs" });
    expect(w.remoteTips(BRANCHES)).toEqual(remote);
  });

  it("withdraws a conflict it queued for a run that a newer run replaced while it was being delivered", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    // 第一次没递进去（收件人认不出）
    vi.mocked(w.deps.deliver).mockResolvedValueOnce(false);
    w.pushMain("b.txt", "main's b\n");
    await w.svc.tick();
    const old = w.repoT.lastRun(id)!;
    expect(old).toMatchObject({ outcome: "conflict" });
    expect(old.detail.delivered).toBeFalsy();
    // session 停下来时补递；排进信箱的同时又跑了一次新的 run
    vi.mocked(w.deps.deliver).mockImplementationOnce(async (to, text) => {
      w.delivered.push({ ticketKey: to.ticketKey, text });
      const newer = w.repoT.startRun(id, "manual", "update_refs");
      w.repoT.finishRun(newer, { outcome: "deferred", reason: "busy" });
      return true;
    });
    await w.svc.sessionStopped("B");
    expect(w.delivered).toHaveLength(1);
    expect(w.withdrawn).toEqual(["B:b"]);
    expect(w.repoT.run(old.id)!.detail.delivered).toBeFalsy();
    expect(w.repoT.layers(id)[1]!.conflictKey).toBeNull();
  });

  it("resends the newer run's conflict on the same layer when it withdraws a stale one", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    vi.mocked(w.deps.deliver).mockResolvedValueOnce(false);
    w.pushMain("b.txt", "main's b\n");
    await w.svc.tick();
    const old = w.repoT.lastRun(id)!;
    let newer = 0;
    vi.mocked(w.deps.deliver).mockImplementationOnce(async (to, text) => {
      w.delivered.push({ ticketKey: to.ticketKey, text });
      // 同一层又冲突了一次，而且已经送过（同一个 ref，信箱里那条是它的）
      newer = w.repoT.startRun(id, "manual", "update_refs");
      w.repoT.finishRun(newer, { outcome: "conflict", reason: old.reason, detail: { ...old.detail, delivered: true } });
      return true;
    });
    await w.svc.sessionStopped("B");
    expect(w.withdrawn).toEqual(["B:b"]);
    expect(w.delivered).toHaveLength(2);
    expect(w.repoT.run(old.id)!.detail.delivered).toBeFalsy();
    expect(w.repoT.lastRun(id)!.id).toBe(newer);
    expect(w.repoT.layers(id)[1]!.conflictKey).toBe(old.detail.conflict!.key);
  });

  it("does not withdraw a newer delivery that started while a stale one was still being delivered", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    vi.mocked(w.deps.deliver).mockResolvedValueOnce(false);
    w.pushMain("b.txt", "main's b\n");
    await w.svc.tick();
    const old = w.repoT.lastRun(id)!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let newer = 0;
    let second: Promise<void> | null = null;
    let secondStarted!: () => void;
    const started = new Promise<void>((r) => (secondStarted = r));
    // A 递送途中：同一层又冲突了一次（B），B 也开始递送、排进信箱换掉 A；A 先回来，B 后回来
    vi.mocked(w.deps.deliver)
      .mockImplementationOnce(async (to, text) => {
        w.delivered.push({ ticketKey: to.ticketKey, text });
        newer = w.repoT.startRun(id, "manual", "update_refs");
        w.repoT.finishRun(newer, { outcome: "conflict", reason: old.reason, detail: { ...old.detail, delivered: false } });
        second = w.svc.sessionStopped("B");
        await started;
        return true;
      })
      .mockImplementationOnce(async (to, text) => {
        w.delivered.push({ ticketKey: to.ticketKey, text });
        secondStarted();
        await gate;
        return true;
      });
    await w.svc.sessionStopped("B");
    release();
    await second;
    expect(w.withdrawn).toEqual([]);
    expect(w.delivered).toHaveLength(2);
    expect(w.repoT.run(old.id)!.detail.delivered).toBeFalsy();
    expect(w.repoT.run(newer)!.detail.delivered).toBe(true);
    expect(w.repoT.layers(id)[1]!.conflictKey).toBe(old.detail.conflict!.key);
  });

  it("without a remote, or when git can't read it, an unreadable PR list without a slug is: no PRs / unreadable", async () => {
    const gh = await import("./gh-stack");
    const impl = vi.mocked(gh.openPrs).getMockImplementation()!;
    vi.mocked(gh.openPrs).mockResolvedValue(null);
    try {
      // 栈记的 remote 在仓库里没配：确定不在 GitHub 上，当作没有 PR
      const w = world({ policy: { dailyRebase: false } });
      w.deps.slugOf = async () => null;
      const id = await defineAll(w);
      w.repoT.updateStack(id, { remote: "nowhere" });
      const svc = w.svc as unknown as { notGithub(s: unknown): Promise<boolean> };
      expect(await svc.notGithub(w.repoT.get(id)!)).toBe(true);
      // git 出错（配置文件坏了）：不知道，当作读不到
      writeFileSync(join(w.repo, ".git", "config"), "[remote \"origin\"\n\turl = broken\n");
      expect(await svc.notGithub({ ...w.repoT.get(id)!, remote: "origin" })).toBe(false);
    } finally {
      vi.mocked(gh.openPrs).mockImplementation(impl);
    }
  });

  it("hands a conflict over once: no rerun every tick, the session's own moves are not triggers, an unrelated trunk change does not resend it", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.pushMain("b.txt", "main's b\n");
    await w.svc.tick();
    expect(w.delivered).toHaveLength(1);
    for (let n = 0; n < 3; n++) {
      w.advance(60_000);
      await w.svc.tick();
    }
    await w.svc.sessionStopped("B");
    expect(w.delivered).toHaveLength(1);
    expect(w.repoT.runs(id, 10)).toHaveLength(1);
    // session 在自己的分支上接着干活，没照提示 rebase（或者决定不 rebase）：不算「有新提交」，也不去改写它
    g(w.repo, "checkout", "-q", "b");
    const mine = commit(w.repo, "b2.txt", "more\n", "b more");
    g(w.repo, "checkout", "-q", "main");
    w.advance(60_000);
    await w.svc.tick();
    await w.svc.sessionStopped("B");
    expect(w.repoT.runs(id, 10)).toHaveLength(1);
    // trunk 动了、但没动冲突的文件：还是同一个冲突，不再发，b 不动
    w.pushMain("x.txt", "x\n");
    w.advance(5 * 60_000);
    await w.svc.tick();
    await w.svc.sessionStopped("B");
    expect(w.delivered).toHaveLength(1);
    expect(w.repoT.runs(id, 10)).toHaveLength(1);
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "conflict" });
    expect(w.tip("b")).toBe(mine);
    // trunk 又改了冲突的那个文件：是新的冲突，发一次
    w.pushMain("b.txt", "main's b, again\n");
    w.advance(5 * 60_000);
    await w.svc.tick();
    expect(w.delivered).toHaveLength(2);
    expect(w.tip("b")).toBe(mine);
    expect(w.external.filter((e) => e.kind === "force_push")).toEqual([]);
  });

  it("a conflict handed to a session stays the session's: a clean auto run asks first, and a manual rebase takes it back", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.pushMain("b.txt", "main's b\n");
    await w.svc.tick();
    expect(w.delivered).toHaveLength(1);
    expect(w.repoT.layers(id)[1]!.conflictKey).not.toBeNull();
    // trunk 又把 b.txt 删了：现在干净地 rebase 得过去，但 b 的冲突在 session 手里
    g(w.hub, "fetch", "-q", "origin");
    g(w.hub, "rm", "-q", "b.txt");
    g(w.hub, "commit", "-q", "-m", "main drops b.txt");
    g(w.hub, "push", "-q", "origin", "main");
    const before = w.tips(BRANCHES);
    w.advance(5 * 60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "main_updated", outcome: "needs_confirm", detail: { confirm: { why: "handoff", branches: ["b", "c", "d"] } } });
    expect(w.tips(BRANCHES)).toEqual(before);
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "confirm", branch: "b", detail: "handoff" }));
    expect((await w.svc.rebaseNow(id)).ok).toBe(true);
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "manual", outcome: "rebased" });
    expect(w.repoT.layers(id)[1]!.conflictKey).toBeNull();
    // 层收回来了：还排在 session 信箱里没送的那条旧冲突要撤回
    expect(w.withdrawn).toEqual(["B:b"]);
    expect(w.remoteTips(BRANCHES)).toEqual(w.tips(BRANCHES));
  });

  it("never turns rerere on, and never pushes a resolution its session threw away", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.pushMain("b.txt", "main's b\n");
    await w.svc.tick();
    expect(() => g(w.repo, "config", "--local", "--get", "rerere.enabled")).toThrow();
    const cmd = /git rebase --onto (\S+) (\S+)/.exec(w.delivered[0]!.text)!;
    // session 在自己的 worktree 里开着 rerere 试了一次、记下了一个解法，又放弃了
    const wt = join(tempDir(), "wt-b");
    g(w.repo, "worktree", "add", "-q", wt, "b");
    try {
      g(wt, "-c", "rerere.enabled=true", "rebase", "-q", "--onto", cmd[1]!, cmd[2]!);
    } catch {
      // 冲突
    }
    writeFileSync(join(wt, "b.txt"), "b\n");
    g(wt, "-c", "rerere.enabled=true", "rerere");
    g(wt, "rebase", "--abort");
    g(w.repo, "worktree", "remove", "--force", wt);
    const before = w.tips(BRANCHES);
    const remote = w.remoteTips(BRANCHES);
    w.pushMain("x.txt", "x\n");
    w.advance(5 * 60_000);
    await w.svc.tick();
    await w.svc.rebaseNow(id);
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "conflict" });
    expect(w.tips(BRANCHES)).toEqual(before);
    expect(w.remoteTips(BRANCHES)).toEqual(remote);
    expect(w.external.filter((e) => e.kind === "force_push")).toEqual([]);
  });

  it("does not catch up a push onto a layer under review until someone confirms", async () => {
    let on = false;
    const w = world({ policy: { dailyRebase: false }, allow: (k) => k !== "force_push" || on });
    const id = await defineAll(w);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    expect(w.remoteTip("a")).not.toBe(w.tip("a"));
    // 这期间有人把 a 开成了 PR、在 review
    openPr(1, "a", "main", false);
    on = true;
    w.advance(60_000);
    await w.svc.tick();
    expect(w.remoteTip("a")).not.toBe(w.tip("a"));
    expect(w.remoteTips(["b", "c", "d"])).toEqual(w.tips(["b", "c", "d"]));
    expect((await w.svc.rebaseNow(id)).ok).toBe(true);
    expect(w.remoteTip("a")).toBe(w.tip("a"));
  });

  it("asks before an autosquash rewrites a layer under review, and the confirm does the autosquash", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    await w.svc.tick();
    g(w.repo, "checkout", "-q", "b");
    commit(w.repo, "b-fix.txt", "fix\n", "fixup! b one");
    g(w.repo, "checkout", "-q", "main");
    await w.svc.tick(); // layer_commits：c、d 接上去
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "layer_commits", outcome: "rebased" });
    openPr(2, "b", "a", false);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "autosquash", outcome: "needs_confirm" });
    expect(g(w.repo, "log", "--format=%s", "main..b")).toBe("fixup! b one\nb one\na one");
    await w.svc.rebaseNow(id);
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    expect(g(w.repo, "log", "--format=%s", "main..b")).toBe("b one\na one");
  });

  it("does not fold a trunk-update confirm into an autosquash one: the confirm then moves the stack onto trunk", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    await w.svc.tick();
    g(w.repo, "checkout", "-q", "b");
    commit(w.repo, "b-fix.txt", "fix\n", "fixup! b one");
    g(w.repo, "checkout", "-q", "main");
    await w.svc.tick();
    openPr(2, "b", "a", false);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "autosquash", outcome: "needs_confirm", detail: { autosquash: true } });
    w.pushMain("x.txt", "x\n");
    w.advance(5 * 60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "main_updated", outcome: "needs_confirm" });
    expect(w.repoT.lastRun(id)!.detail.autosquash).toBeUndefined();
    await w.svc.rebaseNow(id);
    expect(g(w.repo, "merge-base", "--is-ancestor", "origin/main", "d") === "").toBe(true);
  });

  it("an explicit repo-level off beats a semi epic, a global off does not, and the view says which", async () => {
    const w = world({ autoRebase: false });
    const id = await defineAll(w);
    const name = w.repoT.get(id)!.name;
    const card = async () => (await w.svc.view({ featureId: null })).stacks[0]!;
    w.deps.overlay = (base) => ({ ...base, autoRebase: true });
    expect(w.svc.policyOf(w.repoT.get(id)!).autoRebase).toBe(true);
    expect(await card()).toMatchObject({ autoRebase: true, autoRebaseBy: "epic" });
    expect(w.svc.epicNote({ kind: "global" })).toEqual({ on: [name], ignored: [] });
    w.policy.setLayer({ kind: "repo", slug: "acme/app" }, { autoRebase: false });
    expect(w.svc.policyOf(w.repoT.get(id)!).autoRebase).toBe(false);
    expect(await card()).toMatchObject({ autoRebase: false, autoRebaseBy: "explicit_off" });
    expect(w.svc.epicNote({ kind: "repo", slug: "acme/app" })).toEqual({ on: [], ignored: [name] });
    expect(w.svc.epicNote({ kind: "repo", slug: "other/repo" })).toEqual({ on: [], ignored: [] });
    w.policy.setLayer({ kind: "repo", slug: "acme/app" }, {});
    w.deps.overlay = undefined;
    expect(await card()).toMatchObject({ autoRebase: false, autoRebaseBy: "policy" });
  });
});

describe.skipIf(process.platform === "win32")("an idle tick (BTL-275)", () => {
  it("with nothing changed sends no onChange and asks git once per stack; a trunk that moved notifies", async () => {
    const w = world({ autoRebase: false });
    await defineAll(w);
    let changes = 0;
    w.deps.onChange = () => void changes++;
    await w.svc.tick();
    expect(changes).toBe(1); // 第一次 tick 总是发
    changes = 0;
    const gits = await countGits();
    try {
      for (let i = 0; i < 3; i++) {
        w.advance(60_000);
        await w.svc.tick();
      }
      expect(changes).toBe(0);
      expect(gits.n()).toBe(3);
    } finally {
      gits.done();
    }
    w.pushMain("x.txt", "x\n");
    w.advance(5 * 60_000);
    await w.svc.tick();
    expect(changes).toBe(1);
    expect((await w.svc.view({ featureId: null })).stacks[0]!.layers[0]!.behind).toBe(1);
  });

  it("with autoRebase on and nothing to do: no onChange, one git per tick; a new commit on a layer still rebases and notifies", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    let changes = 0;
    w.deps.onChange = () => void changes++;
    await w.svc.tick();
    w.advance(60_000);
    await w.svc.tick();
    changes = 0;
    const gits = await countGits();
    try {
      for (let i = 0; i < 3; i++) {
        w.advance(60_000);
        await w.svc.tick();
      }
      expect(changes).toBe(0);
      expect(gits.n()).toBe(3);
    } finally {
      gits.done();
    }
    g(w.repo, "checkout", "-q", "b");
    commit(w.repo, "b-more.txt", "more\n", "b more");
    g(w.repo, "checkout", "-q", "main");
    w.advance(60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "layer_commits", outcome: "rebased" });
    expect(changes).toBeGreaterThan(0);
  });

  it("a notice that appears only because time passed still notifies", async () => {
    const w = world({ autoRebase: false, policy: { behindCommits: 100, behindDays: 1 } });
    await defineAll(w);
    w.pushMain("x.txt", "x\n");
    w.advance(5 * 60_000);
    await w.svc.tick();
    const behindNow = () => w.svc.notices().some((n) => n.reason === "behind");
    let changes = 0;
    w.deps.onChange = () => void changes++;
    // 一直往后推：落后天数一跨过 behindDays，提醒出来的那次 tick 要发
    for (let i = 0; i < 40 && !behindNow(); i++) {
      w.advance(86_400_000);
      changes = 0;
      await w.svc.tick();
    }
    expect(behindNow()).toBe(true);
    expect(changes).toBe(1);
  });
});

describe.skipIf(process.env.SHIPHERD_PERF_BENCH !== "1" || process.platform === "win32")("idle tick bench (BTL-275)", () => {
  it.each([["autoRebase on", true], ["autoRebase off", false]] as const)("an unchanged 4-layer stack (%s)", async (_n, autoRebase) => {
    const { setGitBinary, resetGitBinary } = await import("../util/git-path");
    const dir = tempDir("shipherd-gitcount-");
    const log = join(dir, "calls");
    const wrapper = join(dir, "git");
    writeFileSync(wrapper, `#!/bin/sh\necho x >> "${log}"\nexec /usr/bin/env git "$@"\n`, { mode: 0o755 });
    const w = world({ autoRebase });
    await defineAll(w);
    let changes = 0;
    w.deps.onChange = () => void changes++;
    await w.svc.tick(); // 第一次：建基线
    setGitBinary(wrapper);
    try {
      changes = 0;
      writeFileSync(log, "");
      const n = 10;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        w.advance(60_000);
        await w.svc.tick();
      }
      const ms = (performance.now() - t0) / n;
      const gits = (await import("node:fs")).readFileSync(log, "utf8").split("\n").filter(Boolean).length;
      console.log(`[idle-bench] stack tick (${_n}): ${changes}/${n} ticks sent onChange, ${(gits / n).toFixed(1)} git per tick, ${ms.toFixed(1)} ms per tick`);
    } finally {
      resetGitBinary();
    }
  });
});
