import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoLockKey, repoLocks } from "../tickets/repo-lock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalActionKind } from "../../shared/external";
import { parseRemoteSlug } from "../../shared/repo-slug";
import type { StackRunMode } from "../../shared/stacks";
import { JOB_STACKS_DAILY, JobsRepo } from "../db/jobs-repo";
import { StacksRepo } from "../db/stacks-repo";
import type { ExternalDetail } from "../external/actions";
import { copyRepo, makeRepo, memDb, setOriginUrl, tempDir } from "../test-utils";
import type { CreatePr, PrSnapshot } from "./gh-stack";
import { T } from "./pr-text";
import { StackPolicyService } from "./stack-policy";
import { reasonKey, remoteKind, stackMailRef, stackMailRepoIdOf, StackService, type StackServiceDeps } from "./stack-service";

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
 * 不存在的提交：markersVsRemote 拿它当新起点就真的查不了（git 出错，和真的一样记成 null、按退避重查），
 * 「现在」页和 heldBy 照真实情况认。不要让 spy 直接返回 null：那样什么都没记下。
 */
const NO_BASE = "0".repeat(40);

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
  const verify: { ticketKey: string; text: string }[] = [];
  const verifyWithdrawn: string[] = [];
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
    deliver: vi.fn(async (to: { ticketKey: string }, text: string, topic?: "verify") =>
      (topic === "verify" ? verify.push({ ticketKey: to.ticketKey, text }) : delivered.push({ ticketKey: to.ticketKey, text }), true)),
    withdraw: vi.fn((to: { ticketKey: string; branch: string }, topic?: "verify") => void (topic ? verifyWithdrawn : withdrawn).push(`${to.ticketKey}:${to.branch}`)),
    briefProvider: (l) => ({ markdown: `<!-- shipherd:brief -->brief for ${l.branch}<!-- /shipherd:brief -->`, posted: (url) => posted.push(url) }),
    forceMode: o.mode,
  };
  const svc = new StackService(deps);
  return {
    repo, remote, hub, db, svc, deps, repoT, policy, external, delivered, withdrawn, posted, verify, verifyWithdrawn,
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

/** rerere 清理的记录（workRoot 旁边：cleanupWork 清 workRoot）。 */
const rerereFile = (w: World) => join(dirname(w.deps.workRoot), "stack-rerere-cleaned.json");

/** 从旧版升级：旧版没有 stack-rerere-cleaned.json，这一版启动时才建（候选 = 那时已有的栈）。 */
function upgraded(w: World): StackService {
  rmSync(rerereFile(w), { force: true });
  return new StackService(w.deps);
}

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
    expect(w.delivered[0]!.text).toContain("git -c rerere.enabled=false rebase --onto");
    // 强推命令锁定交出去时远端的完整 sha（BTL-278）
    const remoteB = w.remoteTips(["b"])[0];
    expect(remoteB).toMatch(/^[0-9a-f]{40}$/);
    expect(w.delivered[0]!.text).toContain(`--force-with-lease=refs/heads/b:${remoteB} --force-if-includes origin HEAD:refs/heads/b`);
    await w.svc.rebaseNow(id);
    expect(w.delivered).toHaveLength(1);
    expect(w.svc.notices().filter((n) => n.reason === "conflict")).toEqual([]);
    expect(g(w.repo, "for-each-ref", "refs/heads/shipherd-stack/")).toBe("");
    expect(g(w.repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("doesn't hand out a force push over a reviewer's commit: auto asks first, and the confirmed handoff has no push command (BTL-278)", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    // reviewer 在 GitHub 上往 b 推了一个 suggestion（本地 b 没有）
    g(w.hub, "fetch", "-q", "origin");
    g(w.hub, "checkout", "-q", "-B", "b", "origin/b");
    commit(w.hub, "suggestion.txt", "s\n", "Apply suggestion");
    g(w.hub, "push", "-q", "origin", "b");
    const x = g(w.hub, "rev-parse", "HEAD");
    w.pushMain("b.txt", "main's b\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "needs_confirm", detail: { confirm: { why: "remote_ahead", branches: ["b"], push: true, toSession: true } } });
    expect(w.delivered).toEqual([]);
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "confirm", detail: "remote_ahead", branches: ["b"], push: true, toSession: true }));
    // 用户确认：交给 session，但不给推送命令
    await w.svc.rebaseNow(id);
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "conflict" });
    expect(w.delivered).toHaveLength(1);
    expect(w.delivered[0]!.text).not.toContain("--force-with-lease");
    expect(w.delivered[0]!.text).toContain(x.slice(0, 7));
    expect(w.delivered[0]!.text).toMatch(/先不要推/);
    expect(g(w.remote, "rev-parse", "b")).toBe(x);
  });

  it("the remote-ahead confirm records that pushing is off and conflicts stay with the user, for its text (BTL-278)", async () => {
    const w = world({ policy: { dailyRebase: false, conflictToSession: false }, allow: (k) => k !== "force_push" });
    const id = await defineAll(w);
    g(w.hub, "fetch", "-q", "origin");
    g(w.hub, "checkout", "-q", "-B", "b", "origin/b");
    commit(w.hub, "suggestion.txt", "s\n", "Apply suggestion");
    g(w.hub, "push", "-q", "origin", "b");
    w.pushMain("b.txt", "main's b\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "needs_confirm", detail: { confirm: { why: "remote_ahead", push: false, toSession: false } } });
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "confirm", detail: "remote_ahead", push: false, toSession: false }));
  });

  it("a resent conflict keeps the lease it was handed with, even after the remote moved (BTL-278)", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    vi.mocked(w.deps.deliver).mockResolvedValueOnce(false);
    const remoteB = w.remoteTips(["b"])[0]!;
    w.pushMain("b.txt", "main's b\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "conflict", detail: { conflict: { lease: { remote: "origin", sha: remoteB, ahead: false } } } });
    // 送出去之前 reviewer 推了提交，Shipherd 也 fetch 到了
    g(w.hub, "fetch", "-q", "origin");
    g(w.hub, "checkout", "-q", "-B", "b", "origin/b");
    commit(w.hub, "suggestion.txt", "s\n", "Apply suggestion");
    g(w.hub, "push", "-q", "origin", "b");
    g(w.repo, "fetch", "-q", "origin");
    await w.svc.sessionStopped("B");
    expect(w.delivered).toHaveLength(1);
    // 还是锁交出去时的那个 sha：照着推会被拒，不会冲掉 reviewer 的提交
    expect(w.delivered[0]!.text).toContain(`--force-with-lease=refs/heads/b:${remoteB} `);
  });

  it("after the session follows the conflict instructions, the next run carries on from its resolution", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.pushMain("b.txt", "main's b\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "conflict" });
    const cmd = /git -c rerere\.enabled=false rebase --onto (\S+) (\S+)/.exec(w.delivered[0]!.text)!;
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

  it("addresses a layer's mail by ticket, repository and branch: the same ticket and branch in another repository is another letter (BTL-278)", async () => {
    // 同一个 ticket 跨两个仓库、分支同名
    const repos = [
      { id: 1, repoPath: "/w/api", branch: "feature/X-1" },
      { id: 2, repoPath: "/w/web", branch: "feature/X-1" },
    ];
    const same = (a: string, b: string) => a === b;
    const web = { ticketKey: "X-1", ticketRepoId: null, repoPath: "/w/web", branch: "feature/X-1" };
    expect(stackMailRepoIdOf(web, repos, same)).toBe(2);
    expect(stackMailRepoIdOf({ ...web, repoPath: "/w/other" }, repos, same)).toBeNull();
    expect(stackMailRepoIdOf({ ...web, ticketRepoId: 1 }, repos, same)).toBe(1);
    // 一边的新信、撤回用的 ref 和另一边的不一样
    expect(stackMailRef(web, 1)).not.toBe(stackMailRef(web, 2));
    expect(stackMailRef(web, 1, "verify")).not.toBe(stackMailRef(web, 2, "verify"));
    expect(stackMailRef(web, 1)).not.toBe(stackMailRef(web, 1, "verify"));
    // 栈服务递信时带上自己的仓库
    const w = world({ policy: { dailyRebase: false } });
    await defineAll(w);
    w.pushMain("m.txt", "m\n");
    await w.svc.tick();
    expect(vi.mocked(w.deps.deliver).mock.calls.map((c) => c[0].repoPath)).toEqual(expect.arrayContaining([w.repo]));
    expect(vi.mocked(w.deps.deliver).mock.calls.every((c) => c[0].repoPath === w.repo)).toBe(true);
  });

  it("withdraws the verify requests of the rewrite it undoes (BTL-278)", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.pushMain("m.txt", "m\n");
    await w.svc.tick();
    expect(w.verify.map((v) => v.ticketKey)).toEqual(["A", "B", "C", "D"]);
    expect(w.verifyWithdrawn).toEqual([]);
    expect(await w.svc.restore(id)).toEqual({ ok: true });
    expect(w.verifyWithdrawn).toEqual(["A:a", "B:b", "C:c", "D:d"]);
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

  it("a manual confirm still runs the checks before the force push, even when the PRs can't be read", async () => {
    const w = world({ policy: { dailyRebase: false } });
    openPr(1, "a", "main", false);
    const id = (await w.svc.define({ repoPath: w.repo, branches: ["a", "b"], source: "mcp" })).stackId!;
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)!.outcome).toBe("needs_confirm");
    // 别人刚往 a 的 PR 推了一个提交：手动确认也不能盖掉它；GitHub 读不到也一样（手动跑不因此推迟，git 上的检查照做）
    g(w.hub, "fetch", "-q", "origin");
    g(w.hub, "checkout", "-q", "-B", "a", "origin/a");
    g(w.hub, "commit", "-q", "--allow-empty", "-m", "reviewer fix");
    g(w.hub, "push", "-q", "origin", "a");
    const theirs = w.remoteTip("a");
    const gh = await import("./gh-stack");
    for (const unreadable of [true, false]) {
      if (unreadable) vi.mocked(gh.openPrs).mockResolvedValueOnce(null);
      await w.svc.rebaseNow(id);
      expect(w.remoteTip("a")).toBe(theirs);
      expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "manual", reason: "the remote a has commits that are not local" });
    }
  });

  it("a manual run goes ahead when the open PRs can't be read; an automatic one waits (BTL-278)", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    const gh = await import("./gh-stack");
    const impl = vi.mocked(gh.openPrs).getMockImplementation()!;
    vi.mocked(gh.openPrs).mockResolvedValue(null);
    try {
      w.pushMain("x.txt", "x\n");
      const before = w.tips(BRANCHES);
      await w.svc.tick();
      expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred", reason: expect.stringMatching(/^can't read the open PRs/) });
      expect(w.tips(BRANCHES)).toEqual(before);
      await w.svc.rebaseNow(id);
      expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "manual", outcome: "rebased" });
      expect(chainShape(w, BRANCHES).every((x) => x.onTrunk)).toBe(true);
    } finally {
      vi.mocked(gh.openPrs).mockImplementation(impl);
    }
  });

  it("backs off while the open PRs can't be read: 5 minutes, doubling, at most an hour; a manual run still tries", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    const gh = await import("./gh-stack");
    const impl = vi.mocked(gh.openPrs).getMockImplementation()!;
    let calls = 0;
    vi.mocked(gh.openPrs).mockImplementation(async () => (calls++, null));
    w.deps.slugOf = async () => "acme/app";
    w.repoT.updateStack(id, { repoSlug: "acme/app" });
    try {
      w.pushMain("x.txt", "x\n");
      await w.svc.tick();
      expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred", reason: expect.stringMatching(/^can't read the open PRs/) });
      const tries = () => calls;
      const at: number[] = [];
      // 一分钟一个 tick，跑三个小时：每次读不到都等更久
      for (let m = 1; m <= 180; m++) {
        const before = tries();
        w.advance(60_000);
        await w.svc.tick();
        if (tries() > before) at.push(m);
      }
      const gaps = at.map((m, k) => m - (k === 0 ? 0 : at[k - 1]!));
      expect(gaps.slice(0, 4)).toEqual([5, 10, 20, 40]);
      expect(Math.max(...gaps)).toBe(60);
      expect(w.repoT.lastRun(id)!.detail.repeats).toBe(at.length + 1);
      const before = tries();
      await w.svc.rebaseNow(id);
      expect(tries()).toBeGreaterThan(before);
    } finally {
      vi.mocked(gh.openPrs).mockImplementation(impl);
    }
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
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred", reason: expect.stringMatching(/^can't read the open PRs/) });
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
      if (github) expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred", reason: expect.stringMatching(/^can't read the open PRs/) });
      else expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    } finally {
      vi.mocked(gh.openPrs).mockImplementation(impl);
    }
  });

  it("in a fork workflow reads the layers' PRs on upstream, by head repository; a same-named branch in someone else's fork is not ours (BTL-278)", async () => {
    const w = world({ policy: { dailyRebase: false } });
    // origin 是自己的 fork（git 照旧走本地的 bare 仓库），PR 开在 upstream（acme/app）上
    g(w.repo, "remote", "set-url", "origin", "https://github.com/me/app.git");
    g(w.repo, "config", `url.${w.remote}.insteadOf`, "https://github.com/me/app.git");
    w.deps.slugOf = async () => "me/app";
    w.deps.remoteSlugs = async () => ["me/app", "acme/app"];
    const gh = await import("./gh-stack");
    const impl = vi.mocked(gh.openPrs).getMockImplementation()!;
    const up: PrSnapshot[] = [
      { ...openPr(5, "b", "a", false), url: "https://github.com/acme/app/pull/5", crossRepo: true, headRepo: "me/app" },
      { ...openPr(6, "c", "b", false), url: "https://github.com/acme/app/pull/6", crossRepo: true, headRepo: "someone/app" },
    ];
    fake.prs.clear();
    let upstreamOk = true;
    const seen: (string | null)[] = [];
    vi.mocked(gh.openPrs).mockImplementation(async (_c, slug) => (seen.push(slug), slug === "acme/app" ? (upstreamOk ? up : null) : []));
    try {
      const id = await defineAll(w);
      expect(seen).toEqual(expect.arrayContaining(["me/app", "acme/app"]));
      const ls = w.repoT.layers(id);
      expect(ls.find((l) => l.branch === "b")).toMatchObject({ state: "ready", prNumber: 5 });
      expect(ls.find((l) => l.branch === "c")!.prNumber).toBeNull();
      // trunk 跟着 upstream（栈的 remote 是 upstream）：fork 上的分支照样认得出
      g(w.repo, "remote", "add", "upstream", w.remote);
      w.repoT.updateStack(id, { remote: "upstream" });
      w.repoT.updateLayer(w.repoT.layers(id).find((l) => l.branch === "b")!.id, { prNumber: null, prUrl: null, state: "branch_only" });
      await w.svc.stackOn({ repoPath: w.repo, parentBranch: "d", branch: "e", featureId: null }).catch(() => undefined);
      expect(w.repoT.layers(id).find((l) => l.branch === "b")).toMatchObject({ state: "ready", prNumber: 5 });
      w.repoT.updateStack(id, { remote: "origin" });
      // upstream 读不到：不当作没有 PR
      upstreamOk = false;
      w.pushMain("x.txt", "x\n");
      await w.svc.tick();
      expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred", reason: expect.stringMatching(/^can't read the open PRs/) });
    } finally {
      vi.mocked(gh.openPrs).mockImplementation(impl);
    }
  });

  /** fork 工作流：upstream 只有 main，层都在 origin（自己的 fork）上，栈跟着 upstream 的 main。 */
  async function forkWorld() {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    const up = join(tempDir(), "up.git");
    g(tempDir(), "clone", "-q", "--bare", w.remote, up);
    for (const b of BRANCHES) g(up, "branch", "-D", b);
    g(w.repo, "remote", "add", "upstream", up);
    g(w.repo, "fetch", "-q", "upstream");
    w.repoT.updateStack(id, { remote: "upstream" });
    const trunk = (file: string) => {
      w.pushMain(file, `${file}\n`);
      g(w.remote, "push", "-q", up, "main");
    };
    return { w, id, up, trunk };
  }

  /** fork 工作流里 c 只在第三个 remote（other）上：origin、upstream 都没有。 */
  function cOnlyOnOther(w: World): string {
    g(w.remote, "branch", "-D", "c");
    g(w.repo, "update-ref", "-d", "refs/remotes/origin/c");
    const other = join(tempDir(), "other.git");
    g(tempDir(), "init", "-q", "--bare", other);
    g(w.repo, "remote", "add", "other", other);
    g(w.repo, "push", "-q", "other", "c");
    g(w.repo, "fetch", "-q", "other");
    return other;
  }

  function countStarts(w: World): { n: number } {
    const c = { n: 0 };
    const start = w.repoT.startRun.bind(w.repoT);
    w.repoT.startRun = ((...a: Parameters<typeof start>) => (c.n++, start(...a))) as typeof start;
    return c;
  }

  it("in a fork workflow pushes the layers to the fork they live on, never creates them on upstream; a never-pushed layer doesn't hold up the stack (BTL-278)", async () => {
    const { w, id, up, trunk } = await forkWorld();
    trunk("x.txt");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    expect(w.remoteTips(BRANCHES)).toEqual(w.tips(BRANCHES));
    expect(g(up, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
    // c 在哪个 remote 上都还没有（从没推过）：照样改写、推别的层，c 不推，哪儿都不新建（不因为它把整个栈一直推迟）
    g(w.remote, "branch", "-D", "c");
    g(w.repo, "update-ref", "-d", "refs/remotes/origin/c");
    const starts = countStarts(w);
    trunk("y.txt");
    for (let i = 0; i < 6; i++) {
      w.advance(5 * 60_000);
      await w.svc.tick();
    }
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    expect(starts.n).toBe(1);
    expect(w.remoteTips(["a", "b", "d"])).toEqual(w.tips(["a", "b", "d"]));
    expect(g(w.remote, "for-each-ref", "refs/heads/c")).toBe("");
    expect(g(up, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
  });

  it("in a fork workflow defers an automatic run when a layer is only on a third remote, once per trunk (BTL-278)", async () => {
    const { w, id, trunk } = await forkWorld();
    cOnlyOnOther(w);
    const starts = countStarts(w);
    const local = w.tips(BRANCHES);
    trunk("z.txt");
    for (let i = 0; i < 6; i++) {
      w.advance(5 * 60_000);
      await w.svc.tick();
    }
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred", reason: expect.stringContaining("can't tell which remote c is pushed to") });
    expect(w.repoT.lastRun(id)!.reason).toContain("git config branch.c.pushRemote <remote>");
    expect(starts.n).toBe(1);
    expect(w.tips(BRANCHES)).toEqual(local);
    // 手动 rebase 也推迟（改写了也推不出去）：不算成功，给本地化的提示
    expect(await w.svc.rebaseNow(id)).toEqual({ ok: false, message: T("zh").errors.pushRemoteAmbiguous("c") });
    expect(w.tips(BRANCHES)).toEqual(local);
  });

  it("in a fork workflow picks a deferred run up again once the push remote is configured (BTL-278)", async () => {
    const { w, id, up, trunk } = await forkWorld();
    const other = cOnlyOnOther(w);
    trunk("z.txt");
    w.advance(5 * 60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred" });
    // 用户说了推到哪里（branch.c.pushRemote）：一小时后重试时接着跑，c 推到 other 上
    g(w.repo, "config", "branch.c.pushRemote", "other");
    w.advance(30 * 60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred" });
    w.advance(30 * 60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    expect(g(other, "rev-parse", "c")).toBe(w.tip("c"));
    expect(g(w.remote, "for-each-ref", "refs/heads/c")).toBe("");
    expect(g(up, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
  });

  it("defers when the remote branch.<b>.pushRemote names doesn't have the layer but another remote does; a new trunk is tried once, and fixing the config takes effect at once (BTL-278)", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    // c 在 origin 上，配置却说推到 fork（fork 上没有 c）：认不出该推哪个
    const fork = join(tempDir(), "fork.git");
    g(tempDir(), "init", "-q", "--bare", fork);
    g(w.repo, "remote", "add", "fork", fork);
    g(w.repo, "config", "branch.c.pushRemote", "fork");
    const remote = w.remoteTips(BRANCHES);
    const local = w.tips(BRANCHES);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred", reason: expect.stringContaining("can't tell which remote c is pushed to") });
    expect(w.tips(BRANCHES)).toEqual(local);
    expect(w.remoteTips(BRANCHES)).toEqual(remote);
    expect(g(fork, "for-each-ref")).toBe("");
    // trunk 又动了：按新的输入跑一次，还是推迟，并记下新的输入，之后同一个 trunk 不再每轮重跑
    let starts = 0;
    const start = w.repoT.startRun.bind(w.repoT);
    w.repoT.startRun = ((...a: Parameters<typeof start>) => (starts++, start(...a))) as typeof start;
    w.pushMain("y.txt", "y\n");
    for (let i = 0; i < 6; i++) {
      w.advance(5 * 60_000);
      await w.svc.tick();
    }
    expect(starts).toBe(1);
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred", detail: { repeats: 2 } });
    // 刚推迟过（这一轮已经认过推到哪里），用户马上改好配置、点「马上 rebase」：按新配置认，c 推到 origin
    w.pushMain("z.txt", "z\n");
    w.advance(5 * 60_000);
    await w.svc.tick();
    expect(starts).toBe(2);
    g(w.repo, "config", "branch.c.pushRemote", "origin");
    await w.svc.rebaseNow(id);
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "manual", outcome: "rebased" });
    expect(w.remoteTips(BRANCHES)).toEqual(w.tips(BRANCHES));
    expect(g(fork, "for-each-ref")).toBe("");
  });

  it("in a reverse fork (origin is the main repository, the layer lives on a fork remote) never creates the layer on origin (BTL-278)", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    const fork = join(tempDir(), "fork.git");
    g(tempDir(), "clone", "-q", "--bare", w.remote, fork);
    g(w.repo, "remote", "add", "fork", fork);
    g(w.repo, "fetch", "-q", "fork");
    g(w.remote, "branch", "-D", "b");
    g(w.repo, "update-ref", "-d", "refs/remotes/origin/b");
    // b 冲突：交给 session 的提示里不给推送命令（推到 origin 会在主仓库里新建 b），说清楚为什么
    w.pushMain("b.txt", "main's b\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)!.detail.conflict).toMatchObject({ branch: "b", lease: { remote: null } });
    expect(w.delivered[0]!.text).not.toMatch(/git push/);
    expect(w.delivered[0]!.text).toMatch(/认不出这个分支该推到哪个 remote|can't tell which remote this branch goes to/);
    // 开 draft 也不在 origin 上建 b
    const lb = w.repoT.layers(id).find((l) => l.branch === "b")!;
    expect(await w.svc.setLayerMode(lb.id, "draft")).toMatchObject({ ok: false });
    expect(w.external.filter((e) => e.kind === "branch_push")).toEqual([]);
    expect(g(w.remote, "for-each-ref", "refs/heads/b")).toBe("");
  });

  it("in a reverse fork the new bottom is not pushed to origin to open its PR (BTL-278)", async () => {
    const w = world();
    const id = await defineAll(w);
    const fork = join(tempDir(), "fork.git");
    g(tempDir(), "clone", "-q", "--bare", w.remote, fork);
    g(w.repo, "remote", "add", "fork", fork);
    g(w.repo, "fetch", "-q", "fork");
    g(w.remote, "branch", "-D", "b");
    g(w.repo, "update-ref", "-d", "refs/remotes/origin/b");
    const logs: string[] = [];
    w.deps.log = (m: string) => void logs.push(m);
    const head = w.mergeOnHub("a", "squash");
    await w.svc.onMerged({ url: "https://github.com/acme/app/pull/1", number: 1, headSha: head, headBranch: "a" }, w.repo);
    await w.svc.tick();
    // 改写推迟（认不出 b 推到哪里）；新栈底开 PR 那一步也不在 origin 上建 b
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "bottom_merged", outcome: "deferred", reason: expect.stringContaining("can't tell which remote b is pushed to") });
    expect(w.repoT.layers(id)[0]).toMatchObject({ state: "merged" });
    await w.svc.promoteBottom(w.repoT.get(id)!);
    expect(logs).toContain("stacks: not opening the PR of b: can't tell which remote it is pushed to");
    expect(w.external.filter((e) => e.kind === "branch_push")).toEqual([]);
    expect(g(w.remote, "for-each-ref", "refs/heads/b")).toBe("");
    expect(fake.calls.filter((c) => c.fn === "prCreate")).toEqual([]);
  });

  it("pushes a never-pushed new bottom to the remote branch.<b>.pushRemote names to open its PR, not to the trunk's remote (BTL-278)", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    const fork = join(tempDir(), "fork.git");
    g(tempDir(), "init", "-q", "--bare", fork);
    g(w.repo, "remote", "add", "fork", fork);
    g(w.repo, "config", "branch.b.pushRemote", "fork");
    g(w.remote, "branch", "-D", "b");
    g(w.repo, "update-ref", "-d", "refs/remotes/origin/b");
    const head = w.mergeOnHub("a", "squash");
    await w.svc.onMerged({ url: "https://github.com/acme/app/pull/1", number: 1, headSha: head, headBranch: "a" }, w.repo);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "bottom_merged", outcome: "rebased" });
    expect(g(fork, "rev-parse", "b")).toBe(w.tip("b"));
    expect(g(w.remote, "for-each-ref", "refs/heads/b")).toBe("");
    expect(fake.calls.filter((c) => c.fn === "prCreate")).toHaveLength(1);
  });

  it("pushes a layer to the remote of its PR's head repository, even when origin has a branch of that name too (BTL-278)", async () => {
    const w = world({ policy: { dailyRebase: false } });
    // fork 工作流：origin 是自己的 fork（me/app），trunk 跟着 upstream（acme/app）；b 是直接推在 upstream 上开的 PR，
    // origin 上还留着一个同名的旧 b。git 照旧走本地的 bare 仓库（insteadOf），仓库名只在配置里原样的地址上
    const up = join(tempDir(), "up.git");
    g(tempDir(), "clone", "-q", "--bare", w.remote, up);
    g(w.repo, "remote", "set-url", "origin", "https://github.com/me/app.git");
    g(w.repo, "config", `url.${w.remote}.insteadOf`, "https://github.com/me/app.git");
    g(w.repo, "remote", "add", "upstream", "https://github.com/acme/app.git");
    g(w.repo, "config", `url.${up}.insteadOf`, "https://github.com/acme/app.git");
    g(w.repo, "fetch", "-q", "upstream");
    openPr(5, "b", "a", true).headRepo = "acme/app";
    const id = await defineAll(w);
    w.repoT.updateStack(id, { remote: "upstream" });
    expect(w.repoT.layers(id)[1]).toMatchObject({ prNumber: 5 });
    const originB = w.remoteTip("b");
    w.pushMain("x.txt", "x\n");
    g(w.remote, "push", "-q", up, "main");
    await w.svc.rebaseNow(id);
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    expect(g(up, "rev-parse", "b")).toBe(w.tip("b"));
    expect(w.remoteTip("b")).toBe(originB);
    expect(w.remoteTips(["a", "c", "d"])).toEqual(w.tips(["a", "c", "d"]));
  });

  it("without a head repository from gh, falls back to: a PR from a fork is not ours", async () => {
    const w = world({ policy: { dailyRebase: false } });
    openPr(5, "b", "a", false).crossRepo = true;
    openPr(6, "c", "b", false);
    const id = await defineAll(w);
    const ls = w.repoT.layers(id);
    expect(ls.find((l) => l.branch === "b")!.prNumber).toBeNull();
    expect(ls.find((l) => l.branch === "c")).toMatchObject({ prNumber: 6 });
  });

  it.each(["mcp", "ticket"] as const)("on a %s stack, a draft PR the user opened is not Shipherd's draft: its title and body are left alone", async (source) => {
    const w = world({ policy: { dailyRebase: false } });
    openPr(2, "b", "a", true);
    const id = (await w.svc.define({ repoPath: w.repo, branches: BRANCHES, source })).stackId!;
    expect(w.repoT.layers(id)[1]).toMatchObject({ state: "draft", prNumber: 2, mode: "branch" });
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    await w.svc.syncDrafts(w.repoT.get(id)!);
    expect(fake.calls.filter((c) => c.fn === "prEditTitle" || c.fn === "prEditBody")).toEqual([]);
    expect(fake.prs.get(2)!.title).toBe("PR 2");
  });

  it("on a detected stack the drafts are Shipherd's: their mode follows the PR and their titles get k/n", async () => {
    const w = world({ policy: { dailyRebase: false } });
    openPr(1, "a", "main", false);
    openPr(2, "b", "a", true);
    openPr(3, "c", "b", true);
    const [id] = await w.svc.detect(w.repo);
    expect(w.repoT.layers(id!).find((l) => l.branch === "b")).toMatchObject({ state: "draft", mode: "draft" });
    await w.svc.syncDrafts(w.repoT.get(id!)!);
    expect(fake.calls.some((c) => c.fn === "prEditTitle")).toBe(true);
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
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred", reason: expect.stringMatching(/^can't read the open PRs/) });
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

  it.each([
    ["git -C /w/stack-work/run-12/wt rebase failed", "git -C /w/stack-work/run-13/wt rebase failed"],
    ["git update-ref refs/heads/shipherd-stack/12/0 abc failed: x", "git update-ref refs/heads/shipherd-stack/13/0 abc failed: x"],
    [
      "gave up after 30s waiting for lock /r to add stack run 12's temporary worktree; still held by remove stack run 11's temporary worktree",
      "gave up after 31s waiting for lock /r to add stack run 13's temporary worktree; still held by remove stack run 12's temporary worktree",
    ],
    ["error: cannot open /w/stack-work/run-12/seq-editor.js", "error: cannot open /w/stack-work/run-99/seq-editor.js"],
  ])("a failure that only differs by its run reads as the same reason: %s", (a, b) => {
    expect(reasonKey(a, "/w/stack-work")).toBe(reasonKey(b, "/w/stack-work"));
    expect(reasonKey(a, "/w/stack-work")).not.toBe(reasonKey("conflict markers left in a.txt", "/w/stack-work"));
  });

  it.each([
    ["https://github.com/acme/app.git", "github"],
    ["git@github.com:acme/app.git", "github"],
    ["ssh://git@github.example.com/acme/app.git", "github"],
    ["https://github.mycorp.internal/acme/app", "github"],
    ["/Users/me/remote.git", "none"],
    ["../remote.git", "none"],
    ["file:///srv/remote.git", "none"],
    ["C:\\repos\\remote.git", "none"],
    ["https://gitlab.com/acme/app.git", "other"],
    ["git@gitlab.mycorp.com:acme/app.git", "other"],
    ["https://bitbucket.org/acme/app.git", "other"],
    ["https://codeberg.org/acme/app.git", "other"],
    ["https://dev.azure.com/acme/app/_git/app", "other"],
    ["work:acme/app.git", "unknown"],
    ["https://git.mycorp.com/acme/app.git", "unknown"],
    ["", "unknown"],
  ])("classifies the remote %s as %s", (url, kind) => {
    expect(remoteKind(url)).toBe(kind);
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
      const svc = w.svc as unknown as { remoteInfo(s: unknown): Promise<{ kind: string }> };
      expect((await svc.remoteInfo(w.repoT.get(id)!)).kind).toBe("none");
      // git 出错（配置文件坏了）：不知道，当作读不到
      writeFileSync(join(w.repo, ".git", "config"), "[remote \"origin\"\n\turl = broken\n");
      expect((await svc.remoteInfo({ ...w.repoT.get(id)!, remote: "origin" })).kind).toBe("unknown");
    } finally {
      vi.mocked(gh.openPrs).mockImplementation(impl);
    }
  });

  it.each([
    ["a github.com remote", "https://github.com/acme/app.git", true],
    ["an SSH alias", "work:acme/app.git", true],
    ["a GitLab remote", "https://gitlab.com/acme/app.git", false],
    ["a GitLab subgroup", "git@gitlab.com:grp/sub/app.git", false],
    ["a Bitbucket remote", "https://bitbucket.org/acme/app.git", false],
    ["an unknown host", "https://git.mycorp.com/acme/app.git", true],
  ])("with the slug slugOf really gives, an unreadable PR list on %s defers: %s", async (_label, url, defers) => {
    const w = world({ policy: { dailyRebase: false } });
    // 和真的 slugOf 一样：github.com 是 owner/name，别的主机带主机名（BTL-278：GitLab 的 slug 不能交给 gh）
    const slug = parseRemoteSlug(url);
    w.deps.slugOf = async () => slug;
    w.deps.remoteSlugs = async () => (slug ? [slug] : []);
    g(w.repo, "remote", "set-url", "origin", url);
    // git 照旧走本地的 bare 仓库
    g(w.repo, "config", `url.${w.remote}.insteadOf`, url);
    const gh = await import("./gh-stack");
    const impl = vi.mocked(gh.openPrs).getMockImplementation()!;
    vi.mocked(gh.openPrs).mockResolvedValue(null);
    try {
      const id = await defineAll(w);
      w.pushMain("x.txt", "x\n");
      await w.svc.tick();
      if (defers) expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred", reason: expect.stringMatching(/^can't read the open PRs/) });
      else expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
      // 别家主机的 slug 不交给 gh
      expect(vi.mocked(gh.openPrs).mock.calls.map((c) => c[1])).not.toContainEqual(expect.stringMatching(/gitlab|bitbucket/));
      // GitHub Enterprise 这类主机：原因里写上主机和怎么登录
      if (url.includes("mycorp")) expect(w.repoT.lastRun(id)!.reason).toContain("gh auth login --hostname git.mycorp.com");
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

  it("asks before handing a new conflict above a layer whose conflict is still in a session's hands", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.pushMain("b.txt", "main's b\n");
    await w.svc.tick();
    expect(w.delivered).toHaveLength(1);
    // trunk 把 b.txt 删了（b 干净了），又加了一个和 d 冲突的 d.txt：冲突在 d，b 的冲突还在 session 手里
    g(w.hub, "fetch", "-q", "origin");
    g(w.hub, "rm", "-q", "b.txt");
    writeFileSync(join(w.hub, "d.txt"), "main's d\n");
    g(w.hub, "add", "d.txt");
    g(w.hub, "commit", "-q", "-m", "main drops b.txt, adds d.txt");
    g(w.hub, "push", "-q", "origin", "main");
    const before = w.tips(BRANCHES);
    w.advance(5 * 60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "needs_confirm", detail: { confirm: { why: "handoff", branches: ["b", "c", "d"] } } });
    expect(w.delivered).toHaveLength(1);
    expect(w.tips(BRANCHES)).toEqual(before);
    // 确认了：d 的冲突交给 D
    await w.svc.rebaseNow(id);
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "manual", outcome: "conflict" });
    expect(w.delivered.at(-1)!.ticketKey).toBe("D");
  });

  it("turns off the rerere an older Shipherd enabled, once; the session's command reuses no old resolution even with rerere on", async () => {
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    const globalFile = join(tempDir(), "gitconfig");
    writeFileSync(globalFile, "");
    process.env.GIT_CONFIG_GLOBAL = globalFile;
    try {
      const w = world({ policy: { dailyRebase: false } });
      await defineAll(w);
      // 旧版留下的：栈、local 层的 rerere.enabled=true 和共用的 rr-cache；然后升级成这一版
      g(w.repo, "config", "--local", "rerere.enabled", "true");
      const rr = join(w.repo, ".git", "rr-cache");
      mkdirSync(join(rr, "old"), { recursive: true });
      w.svc = upgraded(w);
      w.pushMain("b.txt", "main's b\n");
      await w.svc.tick();
      expect(() => g(w.repo, "config", "--local", "--get", "rerere.enabled")).toThrow();
      expect(existsSync(rr)).toBe(false);
      expect(readdirSync(join(w.repo, ".git")).some((f) => f.startsWith("rr-cache.shipherd-off-"))).toBe(true);
      expect(JSON.parse(readFileSync(rerereFile(w), "utf8"))).toEqual({ candidates: [w.repo], done: [w.repo] });
      // session 开着 rerere 解过一次、记下解法又放弃了；之后就算 rerere 又开着，照提示的命令 rebase 也不会套用
      const cmd = /git -c rerere\.enabled=false rebase --onto (\S+) (\S+)/.exec(w.delivered[0]!.text)!;
      const wt = join(tempDir(), "wt-b");
      g(w.repo, "worktree", "add", "-q", wt, "b");
      try {
        g(wt, "-c", "rerere.enabled=true", "rebase", "-q", "--onto", cmd[1]!, cmd[2]!);
      } catch {
        // 冲突
      }
      writeFileSync(join(wt, "b.txt"), "abandoned\n");
      g(wt, "-c", "rerere.enabled=true", "rerere");
      g(wt, "rebase", "--abort");
      g(w.repo, "config", "--local", "rerere.enabled", "true");
      const r = spawnSync("git", ["-c", "rerere.enabled=false", "rebase", "--onto", cmd[1]!, cmd[2]!], { cwd: wt, encoding: "utf8" });
      expect(`${r.stdout}${r.stderr}`).not.toContain("previous resolution");
      expect(readFileSync(join(wt, "b.txt"), "utf8")).toContain("<<<<<<<");
      g(wt, "rebase", "--abort");
      g(w.repo, "worktree", "remove", "--force", wt);
      // 用户自己又开了：只清一次，重启以后也不再动
      const again = new StackService(w.deps);
      w.pushMain("x.txt", "x\n");
      w.advance(5 * 60_000);
      await again.tick();
      expect(g(w.repo, "config", "--local", "--get", "rerere.enabled")).toBe("true");
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    }
  });

  it.each([
    ["the user set rerere globally", (repo: string, globalFile: string) => writeFileSync(globalFile, "[rerere]\n\tenabled = true\n")],
    ["the local config also has autoUpdate", (repo: string) => g(repo, "config", "--local", "rerere.autoUpdate", "true")],
    ["the local value is not Shipherd's \"true\"", (repo: string) => g(repo, "config", "--local", "rerere.enabled", "yes")],
  ])("leaves rerere alone when %s", async (_label, setup) => {
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    const globalFile = join(tempDir(), "gitconfig");
    writeFileSync(globalFile, "");
    process.env.GIT_CONFIG_GLOBAL = globalFile;
    try {
      const w = world({ policy: { dailyRebase: false } });
      await defineAll(w);
      g(w.repo, "config", "--local", "rerere.enabled", "true");
      setup(w.repo, globalFile);
      const before = g(w.repo, "config", "--local", "--get", "rerere.enabled");
      await upgraded(w).tick();
      expect(g(w.repo, "config", "--local", "--get", "rerere.enabled")).toBe(before);
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    }
  });

  it("cleans a repository whose old stack was deleted and only ever had no-change runs (BTL-278)", async () => {
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    const globalFile = join(tempDir(), "gitconfig");
    writeFileSync(globalFile, "");
    process.env.GIT_CONFIG_GLOBAL = globalFile;
    try {
      const w = world({ policy: { dailyRebase: false } });
      // 旧版在这里建过栈、跑过（没变化的 run 不留行），后来删了；升级以后又建了一个
      const old = await defineAll(w);
      w.repoT.remove(old);
      expect(w.repoT.runs(old)).toEqual([]);
      g(w.repo, "config", "--local", "rerere.enabled", "true");
      w.svc = upgraded(w);
      await defineAll(w);
      w.pushMain("x.txt", "x\n");
      await w.svc.tick();
      expect(() => g(w.repo, "config", "--local", "--get", "rerere.enabled")).toThrow();
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    }
  });

  it("cleans a repository whose stacks were all deleted after the upgrade and never came back (BTL-278)", async () => {
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    const globalFile = join(tempDir(), "gitconfig");
    writeFileSync(globalFile, "");
    process.env.GIT_CONFIG_GLOBAL = globalFile;
    try {
      const w = world({ policy: { dailyRebase: false } });
      const old = await defineAll(w);
      g(w.repo, "config", "--local", "rerere.enabled", "true");
      // 升级时栈还在（算候选），还没跑过一轮就删了，之后这个仓库再没有栈
      w.svc = upgraded(w);
      w.repoT.remove(old);
      expect(w.repoT.list()).toEqual([]);
      await w.svc.tick();
      expect(() => g(w.repo, "config", "--local", "--get", "rerere.enabled")).toThrow();
      expect(JSON.parse(readFileSync(rerereFile(w), "utf8"))).toEqual({ candidates: [w.repo], done: [w.repo] });
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    }
  });

  it("keeps the rerere candidates in memory when the record can't be written, instead of recomputing them from later stacks (BTL-278)", async () => {
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    const globalFile = join(tempDir(), "gitconfig");
    writeFileSync(globalFile, "");
    process.env.GIT_CONFIG_GLOBAL = globalFile;
    try {
      const w = world({ policy: { dailyRebase: false } });
      // 升级时没有栈：没有候选。记录读不了也写不进去（那个路径是个目录）
      rmSync(rerereFile(w), { force: true });
      mkdirSync(rerereFile(w), { recursive: true });
      const svc = new StackService(w.deps);
      w.svc = svc;
      // 之后建的栈、用户自己开的 rerere：不能因为重读不到记录就把它当成旧版留下的
      await defineAll(w);
      g(w.repo, "config", "--local", "rerere.enabled", "true");
      w.pushMain("x.txt", "x\n");
      await svc.tick();
      expect(g(w.repo, "config", "--local", "--get", "rerere.enabled")).toBe("true");
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    }
  });

  it("leaves the rerere a user turned on in a repository that got its first stack after the upgrade (BTL-278)", async () => {
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    const globalFile = join(tempDir(), "gitconfig");
    writeFileSync(globalFile, "");
    process.env.GIT_CONFIG_GLOBAL = globalFile;
    try {
      const w = world({ policy: { dailyRebase: false } });
      await defineAll(w);
      // 这一版启动以后才建的栈：local 层的 rerere 是用户自己开的
      g(w.repo, "config", "--local", "rerere.enabled", "true");
      w.pushMain("x.txt", "x\n");
      await w.svc.tick();
      expect(w.repoT.lastRun(w.repoT.list()[0]!.id)).toMatchObject({ outcome: "rebased" });
      expect(g(w.repo, "config", "--local", "--get", "rerere.enabled")).toBe("true");
      // 跑过一次以后也不再算候选（候选只在第一次建文件时定）
      const again = new StackService(w.deps);
      w.pushMain("y.txt", "y\n");
      w.advance(5 * 60_000);
      await again.tick();
      expect(g(w.repo, "config", "--local", "--get", "rerere.enabled")).toBe("true");
      expect(JSON.parse(readFileSync(rerereFile(w), "utf8"))).toEqual({ candidates: [], done: [w.repo] });
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    }
  });

  it("records a failed --unset (several values) once instead of retrying every tick (BTL-278)", async () => {
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    const globalFile = join(tempDir(), "gitconfig");
    writeFileSync(globalFile, "");
    process.env.GIT_CONFIG_GLOBAL = globalFile;
    try {
      const w = world({ policy: { dailyRebase: false } });
      await defineAll(w);
      g(w.repo, "config", "--local", "--add", "rerere.enabled", "true");
      g(w.repo, "config", "--local", "--add", "rerere.enabled", "true");
      const record = vi.fn();
      w.deps.record = record;
      await upgraded(w).tick();
      w.advance(5 * 60_000);
      await new StackService(w.deps).tick();
      const calls = record.mock.calls.filter((c) => c[0] === "stack.rerere_cleanup");
      expect(calls).toEqual([["stack.rerere_cleanup", { cleaned: false, failed: true }]]);
      expect(g(w.repo, "config", "--local", "--get-all", "rerere.enabled").split("\n")).toEqual(["true", "true"]);
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    }
  });

  it("never turns rerere on, and never pushes a resolution its session threw away", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.pushMain("b.txt", "main's b\n");
    await w.svc.tick();
    expect(() => g(w.repo, "config", "--local", "--get", "rerere.enabled")).toThrow();
    const cmd = /git -c rerere\.enabled=false rebase --onto (\S+) (\S+)/.exec(w.delivered[0]!.text)!;
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

  it("after rewriting layers on its own, asks each layer's session to build and test, and says so on the Now page until someone takes over", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    expect(w.delivered).toEqual([]);
    expect(w.verify.map((v) => v.ticketKey)).toEqual(["A", "B", "C", "D"]);
    const vb = w.verify.find((v) => v.ticketKey === "B")!.text;
    expect(vb).toContain(w.tip("b").slice(0, 7));
    expect(vb).toMatch(/没有编译|didn't build/);
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "rewritten", branches: ["a", "b", "c", "d"] }));
    // b 的 session 接手提交了：b 不再算「没人看过」
    g(w.repo, "checkout", "-q", "b");
    commit(w.repo, "b-fix.txt", "fix\n", "b fix");
    g(w.repo, "checkout", "-q", "main");
    w.advance(60_000);
    await w.svc.tick();
    expect(w.svc.notices().filter((n) => n.reason === "rewritten").flatMap((n) => n.branches ?? [])).not.toContain("b");
    // 一天以后不再提醒
    w.advance(25 * 3600_000);
    expect(w.svc.notices().filter((n) => n.reason === "rewritten")).toEqual([]);
  });

  it("withdraws a queued verify request when the layer then gets a conflict", async () => {
    const w = world({ policy: { dailyRebase: false } });
    await defineAll(w);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.verify).toHaveLength(4);
    w.pushMain("b.txt", "main's b\n");
    w.advance(5 * 60_000);
    await w.svc.tick();
    expect(w.delivered.map((d) => d.ticketKey)).toEqual(["B"]);
    expect(w.verifyWithdrawn).toContain("B:b");
  });

  it("withdraws the verify request on a conflict even when conflicts aren't handed to sessions", async () => {
    const w = world({ policy: { dailyRebase: false } });
    await defineAll(w);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.verify).toHaveLength(4);
    w.policy.setLayer({ kind: "global" }, { autoRebase: true, dailyRebase: false, conflictToSession: false });
    w.pushMain("b.txt", "main's b\n");
    w.advance(5 * 60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(w.repoT.list()[0]!.id)).toMatchObject({ outcome: "conflict" });
    expect(w.delivered).toEqual([]);
    expect(w.verifyWithdrawn).toContain("B:b");
  });

  it("does not catch up a push of a tip that gained conflict markers; a git error skips the push too", async () => {
    let on = false;
    const w = world({ policy: { dailyRebase: false }, allow: (k) => k !== "force_push" || on });
    const id = await defineAll(w);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    const remote = w.remoteTips(BRANCHES);
    // 旧版留下的、还没推出去的 b：文件里有冲突标记
    g(w.repo, "checkout", "-q", "b");
    writeFileSync(join(w.repo, "b.txt"), "<<<<<<< ours\nb\n=======\nmain's b\n>>>>>>> theirs\n");
    g(w.repo, "commit", "-q", "-a", "--amend", "--no-edit");
    g(w.repo, "checkout", "-q", "main");
    const lb = w.repoT.layers(id)[1]!;
    w.repoT.updateLayer(lb.id, { tipSha: w.tip("b") });
    // d 记下的起点 git 里没有：检查做不了，也不推
    w.repoT.updateLayer(w.repoT.layers(id)[3]!.id, { baseSha: "f".repeat(40) });
    on = true;
    w.advance(60_000);
    await w.svc.tick();
    expect(w.remoteTip("a")).toBe(w.tip("a"));
    expect(w.remoteTip("c")).toBe(w.tip("c"));
    expect(w.remoteTip("b")).toBe(remote[1]);
    expect(w.repoT.layers(id)[1]!.remoteOkSha).toBe(remote[1]);
    expect(w.remoteTip("d")).toBe(remote[3]);
  });

  it("checks a held-back push for conflict markers before reading PRs, once per pair of tips, and says so on the Now page (BTL-278)", async () => {
    let on = false;
    const w = world({ policy: { dailyRebase: false }, allow: (k) => k !== "force_push" || on });
    const logs: string[] = [];
    w.deps.log = (m: string) => void logs.push(m);
    const id = await defineAll(w);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    const remote = w.remoteTips(BRANCHES);
    g(w.repo, "checkout", "-q", "b");
    writeFileSync(join(w.repo, "b.txt"), "<<<<<<< ours\nb\n=======\nmain's b\n>>>>>>> theirs\n");
    g(w.repo, "commit", "-q", "-a", "--amend", "--no-edit");
    g(w.repo, "checkout", "-q", "main");
    const lb = w.repoT.layers(id)[1]!;
    w.repoT.updateLayer(lb.id, { tipSha: w.tip("b") });
    on = true;
    w.advance(60_000);
    await w.svc.tick();
    expect(w.remoteTip("c")).toBe(w.tip("c"));
    expect(w.remoteTip("b")).toBe(remote[1]);
    const gh = await import("./gh-stack");
    const n0 = vi.mocked(gh.openPrs).mock.calls.length;
    for (let i = 0; i < 3; i++) {
      w.advance(60_000);
      await w.svc.tick();
    }
    // 只剩 b 等着补推、b 又有标记：不读 PR，也不重查、不重复记
    expect(vi.mocked(gh.openPrs).mock.calls.length).toBe(n0);
    expect(logs.filter((m) => m.includes("conflict markers in b.txt"))).toHaveLength(1);
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "markers", branch: "b", files: ["b.txt"], ticketKey: "B" }));
    // 标记解掉、顶端换了：重查，推出去，提醒没了
    g(w.repo, "checkout", "-q", "b");
    writeFileSync(join(w.repo, "b.txt"), "b\n");
    g(w.repo, "commit", "-q", "-a", "--amend", "--no-edit");
    g(w.repo, "checkout", "-q", "main");
    w.repoT.updateLayer(lb.id, { tipSha: w.tip("b") });
    w.advance(60_000);
    await w.svc.tick();
    expect(w.remoteTip("b")).toBe(w.tip("b"));
    expect(w.svc.notices().filter((n) => n.reason === "markers")).toEqual([]);
  });

  it("the next automatic run doesn't push the conflict markers a held-back push was stopped for (BTL-278)", async () => {
    let on = false;
    const w = world({ policy: { dailyRebase: false }, allow: (k) => k !== "force_push" || on });
    const id = await defineAll(w);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    // 改写后没推出去的 b 里有冲突标记（比如旧版套用 rerere 留下的），远端那份没有
    g(w.repo, "checkout", "-q", "b");
    writeFileSync(join(w.repo, "b.txt"), "<<<<<<< ours\nb\n=======\nmain's b\n>>>>>>> theirs\n");
    g(w.repo, "commit", "-q", "-a", "--amend", "--no-edit");
    g(w.repo, "checkout", "-q", "main");
    const lb = w.repoT.layers(id)[1]!;
    w.repoT.updateLayer(lb.id, { tipSha: w.tip("b") });
    on = true;
    w.advance(60_000);
    await w.svc.tick();
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "markers", branch: "b" }));
    const held = w.remoteTip("b");
    // trunk 又动了：自动 run 改写整个栈（引擎按改写前的本地顶端比，标记当成层自己的放过去），推之前按远端那份再查一次
    w.pushMain("y.txt", "y\n");
    w.advance(5 * 60_000);
    w.verify.length = 0;
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "main_updated", outcome: "rebased" });
    expect(w.remoteTip("b")).toBe(held);
    expect(g(w.remote, "show", "b:b.txt")).not.toContain("<<<<<<<");
    // 它下面的 a 照推；叠在它上面的 c、d 先不推（不然 c、d 会把 b 的标记带上远端）
    expect(w.remoteTip("a")).toBe(w.tip("a"));
    for (const b of ["c", "d"]) expect(w.remoteTip(b)).not.toBe(w.tip(b));
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "markers", branch: "b", files: ["b.txt"] }));
    // b 的 session 收到的核对请求说的是推之前查出了问题，不是「强推开关关着」
    const vb = w.verify.find((v) => v.ticketKey === "B")!.text;
    expect(vb).toMatch(/推之前查出了问题|found a problem before pushing/);
    expect(vb).not.toMatch(/开关关着|switch is off/);
    // 手动 rebase 也不推它
    await w.svc.rebaseNow(id);
    expect(w.remoteTip("b")).toBe(held);
    expect(g(w.remote, "show", "b:b.txt")).not.toContain("<<<<<<<");
  });

  it("checks again in a while when the conflict-marker check itself failed, instead of holding the push for good (BTL-278)", async () => {
    let on = false;
    const w = world({ policy: { dailyRebase: false }, allow: (k) => k !== "force_push" || on });
    await defineAll(w);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    const remote = w.remoteTips(BRANCHES);
    // git grep 出错（这里是坏掉的配置）：查不了，先不推
    g(w.repo, "config", "grep.threads", "abc");
    on = true;
    w.advance(60_000);
    await w.svc.tick();
    expect(w.remoteTips(BRANCHES)).toEqual(remote);
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "markers", files: [] }));
    // 好了以后：过一会儿（5 分钟）再查，干净就推，提醒没了
    g(w.repo, "config", "--unset", "grep.threads");
    w.advance(60_000);
    await w.svc.tick();
    expect(w.remoteTips(BRANCHES)).toEqual(remote);
    w.advance(5 * 60_000);
    await w.svc.tick();
    expect(w.remoteTips(BRANCHES)).toEqual(w.tips(BRANCHES));
    expect(w.svc.notices().filter((n) => n.reason === "markers")).toEqual([]);
  });

  it("doesn't force-push the layers above a layer held back for conflict markers; pushes them all once it's fixed (BTL-278)", async () => {
    let on = false;
    const w = world({ policy: { dailyRebase: false }, allow: (k) => k !== "force_push" || on });
    const id = await defineAll(w);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    // b 改写过、没推出去，又被改成带冲突标记的样子；force_push 打开以后 b 被拦下
    g(w.repo, "checkout", "-q", "b");
    writeFileSync(join(w.repo, "b.txt"), "<<<<<<< ours\nb\n=======\nmain's b\n>>>>>>> theirs\n");
    g(w.repo, "commit", "-q", "-a", "--amend", "--no-edit");
    g(w.repo, "checkout", "-q", "main");
    const lb = w.repoT.layers(id)[1]!;
    w.repoT.updateLayer(lb.id, { tipSha: w.tip("b") });
    on = true;
    w.advance(60_000);
    await w.svc.tick();
    const held = w.remoteTips(BRANCHES);
    // trunk 又动了：这一轮改写了 c、d（它们叠在带标记的 b 上），b 不推，c、d 也不推
    w.pushMain("y.txt", "y\n");
    w.advance(5 * 60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    expect(w.remoteTip("b")).toBe(held[1]);
    expect(w.remoteTips(["c", "d"])).toEqual(held.slice(2));
    expect(w.remoteTip("c")).not.toBe(w.tip("c"));
    for (const b of ["b", "c", "d"]) expect(g(w.remote, "show", `${b}:b.txt`)).not.toContain("<<<<<<<");
    // 也不在补推里推上去，补推也不为它们去读 PR（每分钟一次 gh）
    const readPrs = vi.spyOn(w.svc as unknown as { readPrs: (...a: unknown[]) => Promise<boolean> }, "readPrs");
    for (let i = 0; i < 3; i++) {
      w.advance(60_000);
      await w.svc.tick();
    }
    expect(w.remoteTips(["c", "d"])).toEqual(held.slice(2));
    expect(readPrs).not.toHaveBeenCalled();
    readPrs.mockRestore();
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "markers", branch: "b", files: ["b.txt"] }));
    // session 去掉标记、提交：b、c、d 都推上去
    g(w.repo, "checkout", "-q", "b");
    writeFileSync(join(w.repo, "b.txt"), "b fixed\n");
    g(w.repo, "commit", "-q", "-a", "-m", "fix markers");
    g(w.repo, "checkout", "-q", "main");
    for (let i = 0; i < 3; i++) {
      w.advance(60_000);
      await w.svc.tick();
    }
    expect(w.remoteTips(BRANCHES)).toEqual(w.tips(BRANCHES));
    for (const b of ["b", "c", "d"]) expect(g(w.remote, "show", `${b}:b.txt`)).not.toContain("<<<<<<<");
    expect(w.svc.notices().filter((n) => n.reason === "markers")).toEqual([]);
  });

  it("doesn't push a never-pushed new bottom that carries conflict markers, nor open its PR; does both once it's fixed (BTL-278)", async () => {
    const w = world();
    const id = await defineAll(w);
    for (const b of ["b", "c", "d"]) {
      g(w.remote, "branch", "-D", b);
      g(w.repo, "update-ref", "-d", `refs/remotes/origin/${b}`);
    }
    g(w.repo, "checkout", "-q", "b");
    writeFileSync(join(w.repo, "b.txt"), "<<<<<<< ours\nb\n=======\nmain's b\n>>>>>>> theirs\n");
    g(w.repo, "commit", "-q", "-a", "--amend", "--no-edit");
    g(w.repo, "checkout", "-q", "main");
    for (const b of ["c", "d"]) {
      g(w.repo, "checkout", "-q", b);
      g(w.repo, "rebase", "-q", "--onto", b === "c" ? "b" : "c", `${b}~1`);
    }
    g(w.repo, "checkout", "-q", "main");
    for (const l of w.repoT.layers(id)) w.repoT.updateLayer(l.id, { tipSha: w.tip(l.branch) });
    const head = w.mergeOnHub("a", "squash");
    await w.svc.onMerged({ url: "https://github.com/acme/app/pull/1", number: 1, headSha: head, headBranch: "a" }, w.repo);
    await w.svc.tick();
    expect(g(w.remote, "for-each-ref", "refs/heads/b")).toBe("");
    expect(w.external.filter((e) => e.kind === "branch_push")).toEqual([]);
    expect(fake.calls.filter((c) => c.fn === "prCreate")).toEqual([]);
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "markers", branch: "b", files: ["b.txt"], where: "new_bottom" }));
    // 去掉标记、提交：下一轮推上去、开 PR
    g(w.repo, "checkout", "-q", "b");
    writeFileSync(join(w.repo, "b.txt"), "b fixed\n");
    g(w.repo, "commit", "-q", "-a", "-m", "fix markers");
    g(w.repo, "checkout", "-q", "main");
    for (let i = 0; i < 3; i++) {
      w.advance(60_000);
      await w.svc.tick();
    }
    expect(g(w.remote, "show", "b:b.txt")).toBe("b fixed");
    expect(fake.calls.filter((c) => c.fn === "prCreate")).toHaveLength(1);
    expect(w.svc.notices().filter((n) => n.reason === "markers")).toEqual([]);
  });

  it("in a reverse fork (layers on the fork, the stack on origin) doesn't create an unconfigured new bottom on origin; says how to name its remote (BTL-278)", async () => {
    const w = world();
    const id = await defineAll(w);
    const fork = join(tempDir(), "fork.git");
    g(tempDir(), "clone", "-q", "--bare", w.remote, fork);
    g(w.repo, "remote", "add", "fork", fork);
    g(w.repo, "fetch", "-q", "fork");
    for (const b of ["b", "c", "d"]) {
      g(w.remote, "branch", "-D", b);
      g(w.repo, "update-ref", "-d", `refs/remotes/origin/${b}`);
    }
    g(fork, "branch", "-D", "b");
    g(w.repo, "update-ref", "-d", "refs/remotes/fork/b");
    g(w.repo, "config", "branch.c.pushRemote", "fork");
    g(w.repo, "config", "branch.d.pushRemote", "fork");
    const head = w.mergeOnHub("a", "squash");
    await w.svc.onMerged({ url: "https://github.com/acme/app/pull/1", number: 1, headSha: head, headBranch: "a" }, w.repo);
    await w.svc.tick();
    expect(g(w.remote, "for-each-ref", "refs/heads/b")).toBe("");
    expect(g(fork, "for-each-ref", "refs/heads/b")).toBe("");
    expect(w.external.filter((e) => e.kind === "branch_push")).toEqual([]);
    expect(fake.calls.filter((c) => c.fn === "prCreate")).toEqual([]);
    const n = w.svc.notices().find((x) => x.reason === "no_push_remote");
    expect(n).toMatchObject({ stackId: id, branch: "b" });
    // 指定了推到 fork：下一轮在 fork 上建、开 PR，origin 上照旧没有
    g(w.repo, "config", "branch.b.pushRemote", "fork");
    w.advance(60_000);
    await w.svc.tick();
    expect(g(fork, "rev-parse", "b")).toBe(w.tip("b"));
    expect(g(w.remote, "for-each-ref", "refs/heads/b")).toBe("");
    expect(fake.calls.filter((c) => c.fn === "prCreate")).toHaveLength(1);
    expect(w.svc.notices().filter((x) => x.reason === "no_push_remote")).toEqual([]);
  });

  it("an automatic run doesn't force-push a layer whose conflict-marker check couldn't be done (BTL-278)", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    const svc = w.svc as unknown as { markersVsRemote: (s: unknown, l: { branch: string }, ...rest: unknown[]) => Promise<string[] | null> };
    const real = svc.markersVsRemote.bind(w.svc);
    vi.spyOn(svc, "markersVsRemote").mockImplementation(async (s, l, ...rest) => (l.branch === "b" ? real(s, l, rest[0], rest[1], NO_BASE) : real(s, l, ...rest)));
    const remoteB = w.remoteTip("b");
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.tip("b")).not.toBe(remoteB);
    expect(w.remoteTip("b")).toBe(remoteB);
    expect(w.remoteTip("a")).toBe(w.tip("a"));
    expect(w.repoT.layers(id)[1]!.remoteOkSha).toBe(remoteB);
  });

  it("pushes a layer whose own commits carry marker-like lines after the trunk adds more to the same file (BTL-278)", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    const body = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const block = (n: string) => `<<<<<<< example ${n}\n>>>>>>> example ${n}\n`;
    w.pushMain("doc.md", body);
    await w.svc.tick();
    expect(w.remoteTips(BRANCHES)).toEqual(w.tips(BRANCHES));
    // b 自己的提交在 doc.md 开头写了一段像冲突标记的例子，已经推上去了
    g(w.repo, "checkout", "-q", "b");
    commit(w.repo, "doc.md", block("b") + body, "b: doc example");
    g(w.repo, "checkout", "-q", "main");
    g(w.repo, "push", "-q", "origin", "b");
    w.advance(5 * 60_000);
    await w.svc.tick();
    expect(w.remoteTips(BRANCHES)).toEqual(w.tips(BRANCHES));
    // trunk 在 doc.md 末尾也加了一段：改写后的 b 有两段，一段是它自己的（远端那份就有），一段来自新起点，都不算新冒出来的
    w.pushMain("doc.md", body + block("main"));
    w.advance(5 * 60_000);
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "main_updated", outcome: "rebased" });
    expect(g(w.repo, "show", "b:doc.md")).toBe((block("b") + body + block("main")).trimEnd());
    expect(w.remoteTips(BRANCHES)).toEqual(w.tips(BRANCHES));
  });

  it("records which layers' sessions got the verify request, and tells each why its rewrite wasn't pushed (BTL-278)", async () => {
    const w = world({ policy: { dailyRebase: false }, allow: (k) => k !== "force_push" });
    const id = await defineAll(w);
    // d 从没推过
    g(w.remote, "branch", "-D", "d");
    g(w.repo, "update-ref", "-d", "refs/remotes/origin/d");
    const deliver = w.deps.deliver;
    w.deps.deliver = vi.fn(async (...a: Parameters<typeof deliver>) => (a[2] === "verify" && a[0].ticketKey === "C" ? false : deliver(...a)));
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    const lr = w.repoT.lastRun(id)!;
    expect(lr).toMatchObject({ outcome: "rebased" });
    expect(lr.detail.verifyAsked).toEqual(["a", "b", "d"]);
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "rewritten", branches: BRANCHES, asked: ["a", "b", "d"] }));
    const text = (k: string) => w.verify.find((v) => v.ticketKey === k)!.text;
    expect(text("A")).toMatch(/「强推」开关关着|Force push switch is off/);
    expect(text("D")).toMatch(/远端还没有这个分支|the remote doesn't have this branch yet/);
    expect(text("D")).not.toMatch(/开关关着|switch is off/);
  });

  it("works out each layer's push remote once per round (BTL-278)", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    const spy = vi.spyOn(w.svc as unknown as { pushTargetNow: (repo: string, r: string, b: string, h: string | null) => Promise<unknown> }, "pushTargetNow");
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    expect(w.remoteTips(BRANCHES)).toEqual(w.tips(BRANCHES));
    const per = new Map<string, number>();
    for (const c of spy.mock.calls) per.set(c[2], (per.get(c[2]) ?? 0) + 1);
    expect([...per.values()].every((n) => n === 1)).toBe(true);
    // 下一轮重新认（用户可能刚改了 pushRemote）：哪怕离上一轮没多久（b 有了新提交）
    w.advance(10_000);
    g(w.repo, "checkout", "-q", "b");
    commit(w.repo, "b2.txt", "b2\n", "b two");
    g(w.repo, "checkout", "-q", "main");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "layer_commits", outcome: "rebased" });
    expect(Math.max(...[...new Map(spy.mock.calls.map((c) => [c[2], spy.mock.calls.filter((x) => x[2] === c[2]).length])).values()])).toBe(2);
  });

  it("backs off reading PRs for a held-back push when they can't be read (BTL-278)", async () => {
    let on = false;
    const w = world({ policy: { dailyRebase: false }, allow: (k) => k !== "force_push" || on });
    const id = await defineAll(w);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    const remote = w.remoteTips(BRANCHES);
    const gh = await import("./gh-stack");
    const impl = vi.mocked(gh.openPrs).getMockImplementation()!;
    vi.mocked(gh.openPrs).mockResolvedValue(null);
    try {
      on = true;
      const n0 = vi.mocked(gh.openPrs).mock.calls.length;
      for (let i = 0; i < 4; i++) {
        w.advance(60_000);
        await w.svc.tick();
      }
      // 第一次读不到，之后 5 分钟内不再读
      expect(vi.mocked(gh.openPrs).mock.calls.length - n0).toBe(1);
      expect(w.remoteTips(BRANCHES)).toEqual(remote);
      vi.mocked(gh.openPrs).mockImplementation(impl);
      w.advance(2 * 60_000);
      await w.svc.tick();
      expect(w.remoteTip("b")).toBe(w.tip("b"));
    } finally {
      vi.mocked(gh.openPrs).mockImplementation(impl);
    }
  });

  it("after a day of unreadable PRs on an unknown host, says why and how to sign gh in (BTL-278)", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const url = "https://git.mycorp.com/acme/app.git";
    const slug = parseRemoteSlug(url);
    w.deps.slugOf = async () => slug;
    w.deps.remoteSlugs = async () => [slug!];
    g(w.repo, "remote", "set-url", "origin", url);
    g(w.repo, "config", `url.${w.remote}.insteadOf`, url);
    const gh = await import("./gh-stack");
    const impl = vi.mocked(gh.openPrs).getMockImplementation()!;
    vi.mocked(gh.openPrs).mockResolvedValue(null);
    try {
      const id = await defineAll(w);
      w.pushMain("x.txt", "x\n");
      await w.svc.tick();
      expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred" });
      expect(w.svc.notices().filter((n) => n.reason === "prs_unreadable")).toEqual([]);
      for (let i = 0; i < 30; i++) {
        w.advance(60 * 60_000);
        await w.svc.tick();
      }
      expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "prs_unreadable", host: "git.mycorp.com" }));
      expect(w.svc.notices().filter((n) => n.reason === "stuck")).toEqual([]);
    } finally {
      vi.mocked(gh.openPrs).mockImplementation(impl);
    }
  });

  it("does not catch up a push while a run of the same stack is still going", async () => {
    let on = false;
    const w = world({ policy: { dailyRebase: false }, allow: (k) => k !== "force_push" || on });
    const id = await defineAll(w);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    const remote = w.remoteTips(BRANCHES);
    on = true;
    // 一次手动 run 停在读 PR 上
    const gh = await import("./gh-stack");
    const impl = vi.mocked(gh.openPrs).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(gh.openPrs).mockImplementationOnce(async (...a) => (await gate, impl(...a)));
    const n0 = vi.mocked(gh.openPrs).mock.calls.length;
    const manual = w.svc.rebaseNow(id);
    await vi.waitFor(() => expect(vi.mocked(gh.openPrs).mock.calls.length).toBeGreaterThan(n0));
    w.advance(60_000);
    await w.svc.tick();
    expect(w.remoteTips(BRANCHES)).toEqual(remote);
    release();
    await manual;
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

describe("StackService checks every push for conflict markers (BTL-278, seventh review)", () => {
  const MARK = "<<<<<<< ours\nb\n=======\nmain's b\n>>>>>>> theirs\n";
  /** b 的 session 往 b 里 amend 进一个带冲突标记的解法，没推。 */
  function amendB(w: World, text = MARK): void {
    g(w.repo, "checkout", "-q", "b");
    writeFileSync(join(w.repo, "b.txt"), text);
    g(w.repo, "commit", "-q", "-a", "--amend", "--no-edit");
    g(w.repo, "checkout", "-q", "main");
  }
  function fixB(w: World): void {
    g(w.repo, "checkout", "-q", "b");
    writeFileSync(join(w.repo, "b.txt"), "b fixed\n");
    g(w.repo, "commit", "-q", "-a", "-m", "fix markers");
    g(w.repo, "checkout", "-q", "main");
  }
  const onRemote = (w: World, b: string) => g(w.remote, "for-each-ref", `refs/heads/${b}`) !== "";
  /** b、c、d 从远端删掉（从没推过的层）。 */
  function unpushBCD(w: World): void {
    for (const b of ["b", "c", "d"]) {
      g(w.remote, "branch", "-D", b);
      g(w.repo, "update-ref", "-d", `refs/remotes/origin/${b}`);
    }
  }
  type Spy = { markersVsRemote: (s: unknown, l: { branch: string }, ...rest: unknown[]) => Promise<string[] | null> };

  it("opening a draft doesn't push a never-pushed layer that carries conflict markers; does once it's fixed", async () => {
    const w = world();
    const id = await defineAll(w);
    unpushBCD(w);
    amendB(w);
    const lb = w.repoT.layers(id)[1]!;
    w.repoT.updateLayer(lb.id, { tipSha: w.tip("b") });
    const r = await w.svc.setLayerMode(lb.id, "draft");
    expect(r).toEqual({ ok: false, message: T().errors.markers("b", "b.txt") });
    expect(onRemote(w, "b")).toBe(false);
    expect(fake.calls.filter((c) => c.fn === "prCreate")).toEqual([]);
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "markers", branch: "b", files: ["b.txt"], where: "new_layer" }));
    fixB(w);
    expect(await w.svc.setLayerMode(lb.id, "draft")).toEqual({ ok: true });
    expect(w.remoteTip("b")).toBe(w.tip("b"));
    expect(fake.calls.filter((c) => c.fn === "prCreate")).toHaveLength(1);
  });

  it("opening a draft for a layer doesn't push its never-pushed parent that carries conflict markers", async () => {
    const w = world();
    const id = await defineAll(w);
    unpushBCD(w);
    amendB(w);
    g(w.repo, "checkout", "-q", "c");
    g(w.repo, "rebase", "-q", "--onto", "b", "c~1");
    g(w.repo, "checkout", "-q", "main");
    for (const l of w.repoT.layers(id)) w.repoT.updateLayer(l.id, { tipSha: w.tip(l.branch) });
    const r = await w.svc.setLayerMode(w.repoT.layers(id)[2]!.id, "draft");
    expect(r).toEqual({ ok: false, message: T().errors.markers("b", "b.txt") });
    expect(onRemote(w, "b")).toBe(false);
    expect(onRemote(w, "c")).toBe(false);
    expect(w.external.filter((e) => e.kind === "branch_push")).toEqual([]);
  });

  it("opening a draft doesn't push a layer that sits on a parent's unpushed commit with conflict markers", async () => {
    const w = world();
    const id = await defineAll(w);
    // b 在远端，本地多了一个带标记、没推的提交；c 从没推过，叠在它上面
    for (const b of ["c", "d"]) {
      g(w.remote, "branch", "-D", b);
      g(w.repo, "update-ref", "-d", `refs/remotes/origin/${b}`);
    }
    g(w.repo, "checkout", "-q", "b");
    writeFileSync(join(w.repo, "b.txt"), MARK);
    g(w.repo, "commit", "-q", "-a", "-m", "resolve (badly)");
    g(w.repo, "checkout", "-q", "c");
    g(w.repo, "rebase", "-q", "--onto", "b", "c~1");
    g(w.repo, "checkout", "-q", "main");
    const remoteB = w.remoteTip("b");
    const r = await w.svc.setLayerMode(w.repoT.layers(id)[2]!.id, "draft");
    expect(r).toEqual({ ok: false, message: T().errors.heldBelow("c", "b") });
    expect(onRemote(w, "c")).toBe(false);
    expect(w.remoteTip("b")).toBe(remoteB);
    expect(fake.calls.filter((c) => c.fn === "prCreate")).toEqual([]);
  });

  it("opening a draft doesn't push a never-pushed layer whose conflict-marker check couldn't be done", async () => {
    const w = world();
    const id = await defineAll(w);
    unpushBCD(w);
    const svc = w.svc as unknown as Spy;
    const real = svc.markersVsRemote.bind(w.svc);
    vi.spyOn(svc, "markersVsRemote").mockImplementation(async (s, l, ...rest) => (l.branch === "b" ? real(s, l, rest[0], rest[1], NO_BASE) : real(s, l, ...rest)));
    const r = await w.svc.setLayerMode(w.repoT.layers(id)[1]!.id, "draft");
    expect(r).toEqual({ ok: false, message: T().errors.markersUnchecked("b") });
    expect(onRemote(w, "b")).toBe(false);
  });

  it("opening a draft pushes the commit it checked, not what the branch points at by the time it pushes", async () => {
    let moved = "";
    const w = world({
      allow: (k) => {
        // 查完、真推之前 b 的 session 又提交了一个带标记的解法
        if (k === "branch_push" && !moved) {
          g(w.repo, "checkout", "-q", "b");
          writeFileSync(join(w.repo, "b.txt"), MARK);
          g(w.repo, "commit", "-q", "-a", "-m", "resolve (badly)");
          g(w.repo, "checkout", "-q", "main");
          moved = w.tip("b");
        }
        return true;
      },
    });
    const id = await defineAll(w);
    unpushBCD(w);
    const checked = w.tip("b");
    expect(await w.svc.setLayerMode(w.repoT.layers(id)[1]!.id, "draft")).toEqual({ ok: true });
    expect(moved).not.toBe("");
    expect(w.remoteTip("b")).toBe(checked);
    expect(g(w.remote, "show", "b:b.txt")).not.toContain("<<<<<<<");
    // 第一次推也设好了上游（session 之后 git push 直接能用）
    expect(g(w.repo, "config", "--get", "branch.b.remote")).toBe("origin");
    expect(g(w.repo, "config", "--get", "branch.b.merge")).toBe("refs/heads/b");
  });

  it("says on the Now page which layer holds the layers above back, when the markers are in the session's own unpushed commit; pushes them once it's fixed", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    // b 的 session amend 进带标记的解法、没推：c、d 不再叠在 b 上，run 只改写 c、d（b 不是 Shipherd 改写的，remoteOkSha 为空）
    amendB(w);
    const remote = w.remoteTips(["c", "d"]);
    for (let i = 0; i < 3; i++) {
      w.advance(5 * 60_000);
      await w.svc.tick();
    }
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    expect(w.repoT.layers(id)[1]!.remoteOkSha).toBeNull();
    expect(w.remoteTips(["c", "d"])).toEqual(remote);
    // 过了「刚改写」那段时间也还在
    w.advance(3 * 3600_000);
    await w.svc.tick();
    const ns = w.svc.notices();
    expect(ns).toContainEqual(expect.objectContaining({ reason: "markers", branch: "b", files: ["b.txt"], where: "local" }));
    expect(ns).toContainEqual(expect.objectContaining({ reason: "held_below", branch: "c", branches: ["c", "d"], by: "b" }));
    fixB(w);
    for (let i = 0; i < 3; i++) {
      w.advance(60_000);
      await w.svc.tick();
    }
    expect(g(w.remote, "show", "d:b.txt")).not.toContain("<<<<<<<");
    expect(w.svc.notices().filter((n) => n.reason === "markers" || n.reason === "held_below")).toEqual([]);
  });

  it("the held-back notice is about the tip that was held: once the layer has another tip, it's not listed until checked again", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    amendB(w);
    for (let i = 0; i < 3; i++) {
      w.advance(5 * 60_000);
      await w.svc.tick();
    }
    const held = () => w.svc.notices().find((n) => n.reason === "held_below");
    expect(held()).toMatchObject({ branches: ["c", "d"], by: "b" });
    const lc = w.repoT.layers(id)[2]!;
    w.repoT.updateLayer(lc.id, { tipSha: w.tip("main") });
    expect(held()).toMatchObject({ branches: ["d"], by: "b" });
  });

  it.each([false, true])("once the session pushes the layer with the markers itself, its markers notice and the held-back notice go on the next tick (force_push off above: %s)", async (offAbove) => {
    let off = false;
    const w = world({ policy: { dailyRebase: false }, allow: (k, scope) => !(k === "force_push" && off && (scope?.ticketKey === "C" || scope?.ticketKey === "D")) });
    await defineAll(w);
    amendB(w);
    for (let i = 0; i < 3; i++) {
      w.advance(5 * 60_000);
      await w.svc.tick();
    }
    const ours = () => w.svc.notices().filter((n) => n.reason === "markers" || n.reason === "held_below");
    expect(ours().map((n) => n.reason).sort()).toEqual(["held_below", "markers"]);
    // 上面的层不会再推（不会再替它们查谁拦着）时，也不能一直提
    off = offAbove;
    // b 的 session 自己（强）推了上去：远端现在就是这样，Shipherd 不再拦，也不再提它
    g(w.repo, "push", "-q", "-f", "origin", "b");
    w.advance(60_000);
    await w.svc.tick();
    expect(ours()).toEqual([]);
  });

  it("drops the held-back notice when the layer holding it back is pushed by its session, even if the held layer won't be pushed again (V6)", async () => {
    let on = false;
    let cOff = false;
    const w = world({ policy: { dailyRebase: false }, allow: (k, scope) => (k !== "force_push" || on) && !(k === "force_push" && cOff && (scope?.ticketKey === "C" || scope?.ticketKey === "D")) });
    const id = await defineAll(w);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    // b 改写后的顶端带上了标记（像旧版 rerere 套用的那样），c、d 接在它上面
    g(w.repo, "checkout", "-q", "b");
    writeFileSync(join(w.repo, "b.txt"), MARK);
    g(w.repo, "commit", "-q", "-a", "--amend", "--no-edit");
    g(w.repo, "checkout", "-q", "main");
    for (const [b, base] of [["c", "b"], ["d", "c"]] as const) {
      g(w.repo, "checkout", "-q", b);
      g(w.repo, "rebase", "-q", "--onto", base, `${b}~1`);
      g(w.repo, "checkout", "-q", "main");
    }
    const ls = w.repoT.layers(id);
    ls.forEach((l, i) => w.repoT.updateLayer(l.id, { tipSha: w.tip(l.branch), baseSha: i === 0 ? l.baseSha : w.tip(ls[i - 1]!.branch) }));
    on = true;
    w.advance(60_000);
    await w.svc.tick();
    expect(w.svc.notices().find((n) => n.reason === "held_below")).toMatchObject({ branches: ["c", "d"], by: "b" });
    // c、d 的 force_push 关掉了（之后不会再替它们查谁拦着）；b 的 session 自己把 b 推了上去
    cOff = true;
    g(w.repo, "push", "-q", "-f", "origin", "b");
    w.advance(60_000);
    await w.svc.tick();
    const ns = w.svc.notices().filter((n) => n.reason === "markers" || n.reason === "held_below");
    expect(ns.filter((n) => n.reason === "markers")).toEqual([]);
    expect(ns.filter((n) => n.reason === "held_below")).toEqual([]);
  });

  it("a held-back layer its session pushed itself isn't listed as held any more, even with its force_push off", async () => {
    let cOff = false;
    const w = world({ policy: { dailyRebase: false }, allow: (k, scope) => !(k === "force_push" && cOff && scope?.ticketKey === "C") });
    await defineAll(w);
    amendB(w);
    for (let i = 0; i < 3; i++) {
      w.advance(5 * 60_000);
      await w.svc.tick();
    }
    expect(w.svc.notices().find((n) => n.reason === "held_below")).toMatchObject({ branches: ["c", "d"], by: "b" });
    cOff = true;
    g(w.repo, "push", "-q", "-f", "origin", "c");
    w.advance(60_000);
    await w.svc.tick();
    expect(w.svc.notices().filter((n) => n.reason === "held_below")).toEqual([expect.objectContaining({ branches: ["d"], by: "b" })]);
  });

  it("a layer held back because the check below couldn't be done stops being listed once the check passes, even if its push then fails", async () => {
    const w = world({ policy: { dailyRebase: false } });
    await defineAll(w);
    g(w.repo, "checkout", "-q", "b");
    commit(w.repo, "b2.txt", "b2\n", "b two");
    g(w.repo, "checkout", "-q", "main");
    const svc = w.svc as unknown as Spy;
    const real = svc.markersVsRemote.bind(w.svc);
    let broken = true;
    vi.spyOn(svc, "markersVsRemote").mockImplementation(async (s, l, ...rest) => (broken && l.branch === "b" ? real(s, l, rest[0], rest[1], NO_BASE) : real(s, l, ...rest)));
    for (let i = 0; i < 3; i++) {
      w.advance(5 * 60_000);
      await w.svc.tick();
    }
    expect(w.svc.notices().find((n) => n.reason === "held_below")).toMatchObject({ branches: ["c", "d"], by: "b" });
    const tips = w.tips(["c", "d"]);
    // 查得了了：b 干净，c、d 不再被拦；可是推 c、d 失败了
    broken = false;
    const attempt = w.deps.external.attempt.bind(w.deps.external);
    w.deps.external.attempt = (async (kind, detail, run) =>
      attempt(kind, detail, async () => {
        if (kind === "force_push" && (detail.target === "c" || detail.target === "d")) throw new Error("network down");
        return run();
      })) as typeof attempt;
    w.advance(60 * 60_000);
    await w.svc.tick();
    expect(w.tips(["c", "d"])).toEqual(tips);
    expect(w.svc.notices().filter((n) => n.reason === "held_below")).toEqual([]);
  });

  it("doesn't show a markers notice for a tip the layer has moved off, until the new tip is checked", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    amendB(w);
    for (let i = 0; i < 3; i++) {
      w.advance(5 * 60_000);
      await w.svc.tick();
    }
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "markers", branch: "b" }));
    const lb = w.repoT.layers(id)[1]!;
    w.repoT.updateLayer(lb.id, { tipSha: w.tip("main") });
    expect(w.svc.notices().filter((n) => n.reason === "markers")).toEqual([]);
  });

  it("the markers notice goes by the latest check of the layer's tip, not an older one against another remote tip", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    const lb = w.repoT.layers(id)[1]!;
    const tip = w.tip("b");
    const m = (w.svc as unknown as { markersOf: Map<string, unknown> }).markersOf;
    m.set(`${lb.id}:${tip}:null`, { layerId: lb.id, local: tip, remote: null, files: ["old.txt"], at: 1, n: 1 });
    m.set(`${lb.id}:${tip}:r2`, { layerId: lb.id, local: tip, remote: "r2", files: ["b.txt"], at: 2, n: 1 });
    expect(w.svc.notices().filter((n) => n.reason === "markers")).toEqual([expect.objectContaining({ branch: "b", files: ["b.txt"], where: "local" })]);
    // 最近一次查是干净的：不提醒
    m.set(`${lb.id}:${tip}:r3`, { layerId: lb.id, local: tip, remote: "r3", files: [], at: 3, n: 1 });
    expect(w.svc.notices().filter((n) => n.reason === "markers")).toEqual([]);
  });

  it("promoting a new bottom pushes the commit it checked even when the branch moves right before the push", async () => {
    const w = world();
    await defineAll(w);
    unpushBCD(w);
    let moved = "";
    const attempt = w.deps.external.attempt.bind(w.deps.external);
    w.deps.external.attempt = (async (kind, detail, run) =>
      attempt(kind, detail, async () => {
        if (kind === "branch_push" && detail.target === "b" && !moved) {
          g(w.repo, "checkout", "-q", "b");
          writeFileSync(join(w.repo, "b.txt"), MARK);
          g(w.repo, "commit", "-q", "-a", "-m", "resolve (badly)");
          g(w.repo, "checkout", "-q", "main");
          moved = w.tip("b");
        }
        return run();
      })) as typeof attempt;
    const head = w.mergeOnHub("a", "squash");
    await w.svc.onMerged({ url: "https://github.com/acme/app/pull/1", number: 1, headSha: head, headBranch: "a" }, w.repo);
    await w.svc.tick();
    expect(moved).not.toBe("");
    expect(w.remoteTip("b")).not.toBe(moved);
    expect(g(w.remote, "show", "b:b.txt")).not.toContain("<<<<<<<");
  });

  it("holds the layers above when the conflict-marker check of the layer below couldn't be done", async () => {
    const w = world({ policy: { dailyRebase: false } });
    const id = await defineAll(w);
    // b 本地多了一个（干净的）没推的提交，可是查不了它
    g(w.repo, "checkout", "-q", "b");
    commit(w.repo, "b2.txt", "b2\n", "b two");
    g(w.repo, "checkout", "-q", "main");
    const svc = w.svc as unknown as Spy;
    const real = svc.markersVsRemote.bind(w.svc);
    vi.spyOn(svc, "markersVsRemote").mockImplementation(async (s, l, ...rest) => (l.branch === "b" ? real(s, l, rest[0], rest[1], NO_BASE) : real(s, l, ...rest)));
    const remote = w.remoteTips(["c", "d"]);
    for (let i = 0; i < 3; i++) {
      w.advance(5 * 60_000);
      await w.svc.tick();
    }
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    expect(w.tip("c")).not.toBe(remote[0]);
    expect(w.remoteTips(["c", "d"])).toEqual(remote);
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "held_below", by: "b" }));
  });

  it("a catch-up push doesn't push what a session committed while the PRs were read", async () => {
    let on = false;
    const w = world({ policy: { dailyRebase: false }, allow: (k) => k !== "force_push" || on });
    const id = await defineAll(w);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.repoT.layers(id)[3]!.remoteOkSha).not.toBeNull();
    const held = w.remoteTip("d");
    on = true;
    const svc = w.svc as unknown as { readPrs: (...a: unknown[]) => Promise<boolean> };
    const real = svc.readPrs.bind(w.svc);
    vi.spyOn(svc, "readPrs").mockImplementation(async (...a) => {
      const r = await real(...a);
      g(w.repo, "checkout", "-q", "d");
      writeFileSync(join(w.repo, "d.txt"), "<<<<<<< ours\nd\n=======\nother d\n>>>>>>> theirs\n");
      g(w.repo, "commit", "-q", "-a", "-m", "resolve (badly)");
      g(w.repo, "checkout", "-q", "main");
      return r;
    });
    w.advance(60_000);
    await w.svc.tick();
    expect(w.remoteTip("d")).toBe(held);
    expect(g(w.remote, "show", "d:d.txt")).not.toContain("<<<<<<<");
  });

  it("a force push pushes the tip it checked even when the branch moves right before the push", async () => {
    let on = false;
    const w = world({ policy: { dailyRebase: false }, allow: (k) => k !== "force_push" || on });
    const id = await defineAll(w);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    const checked = w.repoT.layers(id)[3]!.tipSha;
    expect(w.remoteTip("d")).not.toBe(checked);
    on = true;
    // 补推：查完、复查完以后，git push 跑起来之前 d 的 session 又提交了带标记的解法
    let moved = "";
    const attempt = w.deps.external.attempt.bind(w.deps.external);
    w.deps.external.attempt = (async (kind, detail, run) =>
      attempt(kind, detail, async () => {
        if (kind === "force_push" && detail.target === "d" && !moved) {
          g(w.repo, "checkout", "-q", "d");
          writeFileSync(join(w.repo, "d.txt"), "<<<<<<< ours\nd\n=======\nother d\n>>>>>>> theirs\n");
          g(w.repo, "commit", "-q", "-a", "-m", "resolve (badly)");
          g(w.repo, "checkout", "-q", "main");
          moved = w.tip("d");
        }
        return run();
      })) as typeof attempt;
    w.advance(60_000);
    await w.svc.tick();
    expect(moved).not.toBe("");
    expect(w.remoteTip("d")).toBe(checked);
    expect(g(w.remote, "show", "d:d.txt")).not.toContain("<<<<<<<");
  });

  it("doesn't push a never-pushed new bottom whose conflict-marker check couldn't be done, nor open its PR", async () => {
    const w = world();
    await defineAll(w);
    unpushBCD(w);
    const svc = w.svc as unknown as Spy;
    const real = svc.markersVsRemote.bind(w.svc);
    vi.spyOn(svc, "markersVsRemote").mockImplementation(async (s, l, ...rest) => (l.branch === "b" ? real(s, l, rest[0], rest[1], NO_BASE) : real(s, l, ...rest)));
    const head = w.mergeOnHub("a", "squash");
    await w.svc.onMerged({ url: "https://github.com/acme/app/pull/1", number: 1, headSha: head, headBranch: "a" }, w.repo);
    await w.svc.tick();
    expect(onRemote(w, "b")).toBe(false);
    expect(fake.calls.filter((c) => c.fn === "prCreate")).toEqual([]);
  });

  it("doesn't push a new bottom that moved to a commit with conflict markers while it was checked, nor open its PR", async () => {
    const w = world();
    await defineAll(w);
    unpushBCD(w);
    const svc = w.svc as unknown as Spy;
    const real = svc.markersVsRemote.bind(w.svc);
    let moved = "";
    vi.spyOn(svc, "markersVsRemote").mockImplementation(async (s, l, ...rest) => {
      const r = await real(s, l, ...rest);
      // 查的是干净的那个提交；查完、复查之前 b 的 session 提交了带标记的解法
      if (l.branch === "b" && !moved) {
        g(w.repo, "checkout", "-q", "b");
        writeFileSync(join(w.repo, "b.txt"), MARK);
        g(w.repo, "commit", "-q", "-a", "-m", "resolve (badly)");
        g(w.repo, "checkout", "-q", "main");
        moved = w.tip("b");
      }
      return r;
    });
    const head = w.mergeOnHub("a", "squash");
    await w.svc.onMerged({ url: "https://github.com/acme/app/pull/1", number: 1, headSha: head, headBranch: "a" }, w.repo);
    for (let i = 0; i < 2; i++) {
      await w.svc.tick();
      w.advance(60_000);
    }
    expect(moved).not.toBe("");
    expect(onRemote(w, "b")).toBe(false);
    expect(fake.calls.filter((c) => c.fn === "prCreate")).toEqual([]);
    expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "markers", branch: "b", files: ["b.txt"], where: "new_bottom" }));
  });

  it("restoring a backup doesn't push the layers above a lower layer it couldn't push that carries conflict markers", async () => {
    let restoring = false;
    const w = world({ policy: { dailyRebase: false }, allow: (k, scope) => !(restoring && k === "force_push" && scope?.ticketKey === "B") });
    const id = await defineAll(w);
    w.pushMain("x.txt", "x\n");
    await w.svc.tick();
    expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
    const rebased = w.remoteTips(["b", "c", "d"]);
    // 恢复时 b 推不了（force_push 对 B 关了），它恢复后的那份查出冲突标记
    restoring = true;
    const svc = w.svc as unknown as Spy;
    const real = svc.markersVsRemote.bind(w.svc);
    vi.spyOn(svc, "markersVsRemote").mockImplementation(async (s, l, ...rest) => (l.branch === "b" ? ["b.txt"] : real(s, l, ...rest)));
    const n0 = w.external.length;
    expect(await w.svc.restore(id)).toEqual({ ok: true });
    expect(w.remoteTips(["b", "c", "d"])).toEqual(rebased);
    expect(w.external.slice(n0).filter((e) => e.kind === "force_push" && e.ran).map((e) => e.detail.target)).toEqual(["a"]);
  });

  describe("reverse fork: a sibling on another remote", () => {
    type PT = { pushTargetNow: (repo: string, stackRemote: string, branch: string, headRepo: string | null, siblings?: string[]) => Promise<{ remote: string | null; ambiguous: boolean }> };
    function forked(w: World) {
      const fork = join(tempDir(), "fork.git");
      g(tempDir(), "clone", "-q", "--bare", w.remote, fork);
      g(w.repo, "remote", "add", "fork", fork);
      return fork;
    }
    it("counts a sibling whose config names the other remote, with no refs anywhere", async () => {
      const w = world();
      forked(w);
      for (const b of ["b", "c"]) g(w.repo, "update-ref", "-d", `refs/remotes/origin/${b}`);
      g(w.repo, "config", "branch.c.pushRemote", "fork");
      const pt = w.svc as unknown as PT;
      expect(await pt.pushTargetNow(w.repo, "origin", "b", null, ["c"])).toEqual({ remote: null, ambiguous: false });
      expect(await pt.pushTargetNow(w.repo, "origin", "b", null, [])).toEqual({ remote: "origin", ambiguous: false });
    });
    it("counts a sibling that is only on the other remote's refs, with no config", async () => {
      const w = world();
      forked(w);
      g(w.repo, "fetch", "-q", "fork");
      for (const b of ["b", "c"]) g(w.repo, "update-ref", "-d", `refs/remotes/origin/${b}`);
      g(w.repo, "update-ref", "-d", "refs/remotes/fork/b");
      const pt = w.svc as unknown as PT;
      expect(await pt.pushTargetNow(w.repo, "origin", "b", null, ["c"])).toEqual({ remote: null, ambiguous: false });
      // 同一个兄弟层 origin 上也有：不算在别处
      g(w.repo, "update-ref", "refs/remotes/origin/c", w.tip("c"));
      expect(await pt.pushTargetNow(w.repo, "origin", "b", null, ["c"])).toEqual({ remote: "origin", ambiguous: false });
    });
  });

  describe("the no-push-remote notice", () => {
    /** 反向 fork：c、d 推在 fork 上，新栈底 b 哪儿都没有、没配置：开 PR 前认不出推到哪。 */
    async function stuckBottom(o: { allow?: (k: ExternalActionKind) => boolean; policy?: Record<string, unknown> } = {}) {
      const w = world(o);
      const id = await defineAll(w);
      const fork = join(tempDir(), "fork.git");
      g(tempDir(), "clone", "-q", "--bare", w.remote, fork);
      g(w.repo, "remote", "add", "fork", fork);
      g(w.repo, "fetch", "-q", "fork");
      unpushBCD(w);
      g(fork, "branch", "-D", "b");
      g(w.repo, "update-ref", "-d", "refs/remotes/fork/b");
      g(w.repo, "config", "branch.c.pushRemote", "fork");
      g(w.repo, "config", "branch.d.pushRemote", "fork");
      const head = w.mergeOnHub("a", "squash");
      await w.svc.onMerged({ url: "https://github.com/acme/app/pull/1", number: 1, headSha: head, headBranch: "a" }, w.repo);
      await w.svc.tick();
      expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "no_push_remote", branch: "b" }));
      return { w, id, fork };
    }
    const np = (w: World) => w.svc.notices().filter((n) => n.reason === "no_push_remote");

    it("goes away once the remote is named, even while opening PRs is switched off", async () => {
      let prOpen = true;
      const { w, fork } = await stuckBottom({ allow: (k) => k !== "pr_open" || prOpen });
      prOpen = false;
      g(w.repo, "config", "branch.b.pushRemote", "fork");
      w.advance(60_000);
      await w.svc.tick();
      expect(np(w)).toEqual([]);
      expect(g(fork, "for-each-ref", "refs/heads/b")).toBe("");
      expect(fake.calls.filter((c) => c.fn === "prCreate")).toEqual([]);
    });

    it("goes away once the bottom no longer needs promoting (autoOpenBottomPr turned off)", async () => {
      const { w } = await stuckBottom();
      w.policy.setLayer({ kind: "global" }, { autoRebase: true, autoOpenBottomPr: false });
      w.advance(60_000);
      await w.svc.tick();
      expect(np(w)).toEqual([]);
    });

    it("is only about the bottom while it has no PR", async () => {
      const { w, id } = await stuckBottom();
      const lb = w.repoT.layers(id)[1]!;
      w.repoT.updateLayer(lb.id, { prNumber: 7, prUrl: "https://github.com/acme/app/pull/7" });
      expect(np(w)).toEqual([]);
      w.repoT.updateLayer(lb.id, { prNumber: null, prUrl: null, state: "merged" });
      expect(np(w)).toEqual([]);
    });
  });

  it("keeps the rerere record across the startup cleanup and restarts, and moves the old one out of the work folder", async () => {
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    const globalFile = join(tempDir(), "gitconfig");
    writeFileSync(globalFile, "");
    process.env.GIT_CONFIG_GLOBAL = globalFile;
    try {
      const w = world({ policy: { dailyRebase: false } });
      // 上一版的记录在 workRoot 里（升级时没有栈：没有候选）
      rmSync(rerereFile(w), { force: true });
      mkdirSync(w.deps.workRoot, { recursive: true });
      const legacy = join(w.deps.workRoot, "rerere-cleaned.json");
      writeFileSync(legacy, JSON.stringify({ candidates: [], done: [] }));
      await defineAll(w);
      g(w.repo, "config", "--local", "rerere.enabled", "true");
      // 两次重启：每次 index.ts 先建 StackService，再 cleanupWork（清空 workRoot）
      for (let i = 0; i < 2; i++) {
        w.svc = new StackService(w.deps);
        w.svc.cleanupWork();
        expect(existsSync(legacy)).toBe(false);
        expect(JSON.parse(readFileSync(rerereFile(w), "utf8")).candidates).toEqual([]);
        w.advance(60_000);
        await w.svc.tick();
        expect(g(w.repo, "config", "--local", "--get", "rerere.enabled")).toBe("true");
      }
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    }
  });

  it("uses the old rerere record from memory when it can't be written to the new place, instead of recomputing the candidates", async () => {
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    const globalFile = join(tempDir(), "gitconfig");
    writeFileSync(globalFile, "");
    process.env.GIT_CONFIG_GLOBAL = globalFile;
    try {
      const w = world({ policy: { dailyRebase: false } });
      // 栈已经在了；上一版的记录说没有候选（这个仓库的 rerere 是用户自己开的）
      await defineAll(w);
      g(w.repo, "config", "--local", "rerere.enabled", "true");
      mkdirSync(w.deps.workRoot, { recursive: true });
      const legacy = join(w.deps.workRoot, "rerere-cleaned.json");
      writeFileSync(legacy, JSON.stringify({ candidates: [], done: [] }));
      // 新位置写不进去（是个目录）
      rmSync(rerereFile(w), { force: true });
      mkdirSync(rerereFile(w), { recursive: true });
      w.svc = new StackService(w.deps);
      w.svc.cleanupWork();
      expect(existsSync(legacy)).toBe(false);
      w.pushMain("x.txt", "x\n");
      w.advance(60_000);
      await w.svc.tick();
      expect(w.repoT.lastRun(w.repoT.list()[0]!.id)).toMatchObject({ outcome: "rebased" });
      expect(g(w.repo, "config", "--local", "--get", "rerere.enabled")).toBe("true");
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    }
  });
  describe("review of a69fa1d7", () => {
    it("a closed ticket's layer stops the whole stack: nothing is rewritten, pushed or opened as a draft, and the notice names it", async () => {
      const w = world({ policy: { dailyRebase: false } });
      const id = await defineAll(w);
      const owned = w.deps.owned;
      let closed = true;
      w.deps.owned = (r, b) => (closed && b === "c" ? null : owned(r, b));
      const before = w.tips(BRANCHES);
      const remoteBefore = w.remoteTips(BRANCHES);
      w.pushMain("x.txt", "x\n");
      w.advance(60_000);
      await w.svc.tick();
      expect(w.tips(BRANCHES)).toEqual(before);
      expect(w.remoteTips(BRANCHES)).toEqual(remoteBefore);
      expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred", reason: "ticket closed or archived: c" });
      expect(w.svc.notices().filter((n) => n.reason === "ticket_closed")).toEqual([expect.objectContaining({ stackId: id, branch: "c", branches: ["c"], ticketKey: "C" })]);
      // 不会过一天变成一条「卡住了」：ticket_closed 那条已经说了
      w.advance(25 * 3600_000);
      await w.svc.tick();
      expect(w.svc.notices().filter((n) => n.reason === "stuck")).toEqual([]);
      expect(w.tips(BRANCHES)).toEqual(before);
      // 「马上 rebase」也不改写，说清楚为什么
      const now = await w.svc.rebaseNow(id);
      expect(now.ok).toBe(false);
      expect(now.message).toContain("c");
      expect(w.tips(BRANCHES)).toEqual(before);
      // 开 draft：这一层关掉的、要先推的父层关掉的，都不推、不开
      unpushBCD(w);
      const [, , lc, ld] = w.repoT.layers(id);
      for (const l of [lc!, ld!]) {
        const r = await w.svc.setLayerMode(l.id, "draft");
        expect(r).toMatchObject({ ok: false });
        expect(r.message).toContain("c ");
      }
      expect(fake.calls.filter((c) => c.fn === "prCreate")).toEqual([]);
      expect(w.external.filter((e) => e.kind === "branch_push")).toEqual([]);
      expect(onRemote(w, "c") || onRemote(w, "d")).toBe(false);
      // ticket 又打开了：下一轮就 rebase，提醒也没了
      closed = false;
      for (const b of ["b", "c", "d"]) g(w.repo, "push", "-q", "origin", b);
      w.advance(60_000);
      await w.svc.tick();
      expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
      expect(w.svc.notices().filter((n) => n.reason === "ticket_closed")).toEqual([]);
    });

    it("restoring the backups doesn't rewrite a closed ticket's branch", async () => {
      const w = world({ policy: { dailyRebase: false } });
      const id = await defineAll(w);
      w.pushMain("m.txt", "m\n");
      await w.svc.tick();
      const after = w.tips(BRANCHES);
      const owned = w.deps.owned;
      w.deps.owned = (r, b) => (b === "c" ? null : owned(r, b));
      const r = await w.svc.restore(id);
      expect(r).toMatchObject({ ok: false });
      expect(r.message).toContain("c ");
      expect(w.tips(BRANCHES)).toEqual(after);
    });

    it("a closed ticket's layer becoming the bottom isn't opened as a PR", async () => {
      const w = world({ policy: { dailyRebase: false } });
      await defineAll(w);
      const owned = w.deps.owned;
      w.deps.owned = (r, b) => (b === "b" ? null : owned(r, b));
      const head = w.mergeOnHub("a", "squash");
      await w.svc.onMerged({ url: "https://github.com/acme/app/pull/1", number: 1, headSha: head, headBranch: "a" }, w.repo);
      w.advance(60_000);
      await w.svc.tick();
      expect(fake.calls.filter((c) => c.fn === "prCreate")).toEqual([]);
      expect(w.svc.notices().filter((n) => n.reason === "ticket_closed")).toEqual([expect.objectContaining({ branch: "b" })]);
    });

    it("a merged layer whose ticket is closed doesn't hold the stack up", async () => {
      const w = world({ policy: { dailyRebase: false } });
      const id = await defineAll(w);
      const head = w.mergeOnHub("a", "squash");
      await w.svc.onMerged({ url: "https://github.com/acme/app/pull/1", number: 1, headSha: head, headBranch: "a" }, w.repo);
      const owned = w.deps.owned;
      w.deps.owned = (r, b) => (b === "a" ? null : owned(r, b));
      w.pushMain("x.txt", "x\n");
      w.advance(10 * 60_000);
      await w.svc.tick();
      // 跑到了引擎（新栈底 b 已经开成 ready PR，所以等确认），没因为 a 推迟
      expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "main_updated", outcome: "needs_confirm" });
      expect(w.svc.notices().filter((n) => n.reason === "ticket_closed")).toEqual([]);
    });

    it("held-back notice goes once Shipherd itself pushes the holding layer after its check passes, force_push off above", async () => {
      let cOff = false;
      const w = world({ policy: { dailyRebase: false }, allow: (k, scope) => !(k === "force_push" && cOff && (scope?.ticketKey === "C" || scope?.ticketKey === "D")) });
      await defineAll(w);
      const svc = w.svc as unknown as Spy;
      const real = svc.markersVsRemote.bind(w.svc);
      let broken = true;
      vi.spyOn(svc, "markersVsRemote").mockImplementation(async (s, l, ...rest) => (broken && l.branch === "b" ? real(s, l, rest[0], rest[1], NO_BASE) : real(s, l, ...rest)));
      w.pushMain("x.txt", "x\n");
      w.advance(60_000);
      await w.svc.tick();
      expect(w.svc.notices().find((n) => n.reason === "held_below")).toMatchObject({ branches: ["c", "d"], by: "b" });
      const before = w.remoteTip("b");
      cOff = true;
      broken = false;
      w.advance(60 * 60_000);
      await w.svc.tick();
      expect(w.remoteTip("b")).not.toBe(before);
      expect(w.remoteTip("b")).toBe(w.tip("b"));
      w.advance(60_000);
      await w.svc.tick();
      expect(w.svc.notices().filter((n) => n.reason === "held_below")).toEqual([]);
    });

    /** b 带着标记没推，c、d 因此被拦（「c、d 被 b 拦」），之后 c、d 的 force_push 关掉（不会再替它们查谁拦着）。 */
    async function heldByB(w: World): Promise<number> {
      const id = await defineAll(w);
      amendB(w);
      for (let i = 0; i < 3; i++) {
        w.advance(5 * 60_000);
        await w.svc.tick();
      }
      expect(w.svc.notices().find((n) => n.reason === "held_below")).toMatchObject({ branches: ["c", "d"], by: "b" });
      return id;
    }
    const offAbove = () => {
      const st = { cOff: false };
      return { st, allow: (k: ExternalActionKind, scope?: ExternalDetail["scope"]) => !(k === "force_push" && st.cOff && (scope?.ticketKey === "C" || scope?.ticketKey === "D")) };
    };

    it("removing the holding layer from the stack doesn't leave a held-back notice naming it", async () => {
      const { st, allow } = offAbove();
      const w = world({ policy: { dailyRebase: false }, allow });
      const id = await heldByB(w);
      st.cOff = true;
      expect((await w.svc.define({ repoPath: w.repo, branches: ["a", "c", "d"], source: "mcp", stackId: id })).ok).toBe(true);
      for (let i = 0; i < 2; i++) {
        w.advance(5 * 60_000);
        await w.svc.tick();
      }
      expect(w.svc.notices().filter((n) => n.reason === "held_below")).toEqual([]);
    });

    it("a merged holding layer doesn't hold anything", async () => {
      const w = world({ policy: { dailyRebase: false } });
      const id = await heldByB(w);
      w.repoT.updateLayer(w.repoT.layers(id)[1]!.id, { state: "merged" });
      expect(w.svc.notices().filter((n) => n.reason === "held_below")).toEqual([]);
    });

    it("a tick doesn't touch the notices of a stack that's running; it does once the run is done", async () => {
      const { st, allow } = offAbove();
      const w = world({ policy: { dailyRebase: false }, allow });
      const id = await heldByB(w);
      st.cOff = true;
      g(w.repo, "push", "-q", "-f", "origin", "b");
      // 手动 rebase 停在 fetch 上（栈在跑）的时候来一个 tick
      const svc = w.svc as unknown as { fetch: (r: string, remote: string, force: boolean) => Promise<boolean> };
      const real = svc.fetch.bind(w.svc);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let blocked = false;
      vi.spyOn(svc, "fetch").mockImplementation(async (r, remote, force) => {
        if (force && !blocked) {
          blocked = true;
          await gate;
        }
        return real(r, remote, force);
      });
      const manual = w.svc.rebaseNow(id);
      await vi.waitFor(() => expect(blocked).toBe(true));
      w.advance(60_000);
      await w.svc.tick();
      expect(w.svc.notices().filter((n) => n.reason === "held_below")).not.toEqual([]);
      release();
      await manual;
      w.advance(60_000);
      await w.svc.tick();
      expect(w.svc.notices().filter((n) => n.reason === "held_below" || n.reason === "markers")).toEqual([]);
    });

    it("after a reorder only the layers still above the holding layer are listed as held", async () => {
      const { st, allow } = offAbove();
      const w = world({ policy: { dailyRebase: false }, allow });
      const id = await heldByB(w);
      st.cOff = true;
      expect((await w.svc.define({ repoPath: w.repo, branches: ["a", "c", "b", "d"], source: "mcp", stackId: id })).ok).toBe(true);
      expect(w.svc.notices().filter((n) => n.reason === "held_below")).toEqual([expect.objectContaining({ branches: ["d"], by: "b" })]);
    });

    it("a layer with the same branch name in another repo's stack being pushed doesn't release this stack's held layers", async () => {
      const { st, allow } = offAbove();
      const w = world({ policy: { dailyRebase: false }, allow });
      await heldByB(w);
      // 另一个仓库里同样 a ← b ← c ← d 的栈：它的 b 也带着标记，然后它的 session 把 b 推了上去
      const other = gitWorld(BRANCHES);
      expect((await w.svc.define({ repoPath: other.repo, branches: BRANCHES, source: "mcp" })).ok).toBe(true);
      g(other.repo, "checkout", "-q", "b");
      writeFileSync(join(other.repo, "b.txt"), MARK);
      g(other.repo, "commit", "-q", "-a", "--amend", "--no-edit");
      g(other.repo, "checkout", "-q", "main");
      for (let i = 0; i < 2; i++) {
        w.advance(5 * 60_000);
        await w.svc.tick();
      }
      const otherId = w.repoT.list().find((s) => s.repoPath !== resolve(w.repo))!.id;
      expect(w.svc.notices().filter((n) => n.reason === "markers" && n.stackId === otherId)).not.toEqual([]);
      st.cOff = true;
      g(other.repo, "push", "-q", "-f", "origin", "b");
      w.advance(60_000);
      await w.svc.tick();
      expect(w.svc.notices().filter((n) => n.reason === "markers" && n.stackId === otherId)).toEqual([]);
      expect(w.svc.notices().filter((n) => n.reason === "held_below" && n.stackId !== otherId)).toEqual([expect.objectContaining({ branches: ["c", "d"], by: "b" })]);
    });

    it("with autoRebase off, a markers notice from opening a draft goes once the session pushes the layer itself", async () => {
      const w = world({ autoRebase: false });
      const id = await defineAll(w);
      unpushBCD(w);
      amendB(w);
      const lb = w.repoT.layers(id)[1]!;
      w.repoT.updateLayer(lb.id, { tipSha: w.tip("b") });
      expect((await w.svc.setLayerMode(lb.id, "draft")).ok).toBe(false);
      expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "markers", branch: "b" }));
      g(w.repo, "push", "-q", "origin", "b");
      w.advance(5 * 60_000);
      await w.svc.tick();
      expect(w.svc.notices().filter((n) => n.reason === "markers")).toEqual([]);
    });

    it("logs when the layer was pushed with the very markers Shipherd found, not when the session fixed them first", async () => {
      for (const fixFirst of [false, true]) {
        const { st, allow } = offAbove();
        const w = world({ policy: { dailyRebase: false }, allow });
        await heldByB(w);
        const logs: string[] = [];
        w.deps.log = (m) => void logs.push(m);
        st.cOff = true;
        if (fixFirst) fixB(w);
        g(w.repo, "push", "-q", "-f", "origin", "b");
        w.advance(60_000);
        await w.svc.tick();
        expect(w.svc.notices().filter((n) => n.reason === "markers" || n.reason === "held_below")).toEqual([]);
        const hit = logs.filter((m) => m.includes("with the conflict markers Shipherd found"));
        expect(hit, `fixFirst ${fixFirst}`).toEqual(fixFirst ? [] : [expect.stringContaining("b was pushed at")]);
        if (!fixFirst) expect(hit[0]).toContain("b.txt");
      }
    });

    describe("review of d00ad481", () => {
      const prCreates = () => fake.calls.filter((c) => c.fn === "prCreate").map((c) => (c.args[0] as CreatePr).head);
      const prTouches = (n: number) => fake.calls.filter((c) => ["prEditBase", "prReady", "prEditTitle", "prEditBody", "prLabel"].includes(c.fn) && c.args[0] === n);

      it("a closed ticket's new bottom isn't pushed, opened, retargeted or marked ready when autoRebase is switched on after the merge; it is once the ticket reopens (P1, P1b)", async () => {
        for (const kind of ["pushed", "never pushed", "draft"] as const) {
          fake.prs.clear();
          fake.calls.length = 0;
          fake.next = 100;
          const w = world({ policy: { dailyRebase: false } });
          const id = await defineAll(w);
          const [la, lb] = w.repoT.layers(id);
          if (kind === "draft") {
            fake.prs.set(1, { number: 1, url: "https://github.com/acme/app/pull/1", state: "OPEN", isDraft: false, title: "A", body: "", base: "main", head: "a", headSha: null, labels: [] });
            w.repoT.updateLayer(la!.id, { prNumber: 1, prUrl: "https://github.com/acme/app/pull/1", state: "ready" });
            expect(await w.svc.setLayerMode(lb!.id, "draft")).toEqual({ ok: true });
            fake.calls.length = 0;
          }
          w.advance(60_000);
          await w.svc.tick();
          w.policy.setLayer({ kind: "global" }, { autoRebase: false, dailyRebase: false });
          if (kind === "never pushed") {
            g(w.remote, "branch", "-D", "b");
            g(w.repo, "update-ref", "-d", "refs/remotes/origin/b");
          }
          const owned = w.deps.owned;
          let closed = true;
          w.deps.owned = (r, b) => (closed && b === "b" ? null : owned(r, b));
          const head = w.mergeOnHub("a", "squash");
          await w.svc.onMerged({ url: "https://github.com/acme/app/pull/1", number: 1, headSha: head, headBranch: "a" }, w.repo);
          w.policy.setLayer({ kind: "global" }, { autoRebase: true, dailyRebase: false });
          w.external.length = 0;
          for (let i = 0; i < 2; i++) {
            w.advance(60_000);
            await w.svc.tick();
          }
          expect(prCreates(), kind).toEqual([]);
          expect(prTouches(100), kind).toEqual([]);
          expect(w.external.filter((e) => e.kind === "branch_push" || e.kind === "pr_open"), kind).toEqual([]);
          expect(onRemote(w, "b"), kind).toBe(kind !== "never pushed");
          expect(w.repoT.layer(lb!.id)!.state, kind).toBe(kind === "draft" ? "draft" : "branch_only");
          // ticket 又打开了：这才提升
          closed = false;
          for (let i = 0; i < 2; i++) {
            w.advance(60_000);
            await w.svc.tick();
          }
          if (kind === "draft") expect(fake.calls.filter((c) => c.fn === "prReady"), kind).toEqual([expect.objectContaining({ args: [100] })]);
          else expect(prCreates(), kind).toEqual(["b"]);
          expect(w.repoT.layer(lb!.id)!.state, kind).toBe("ready");
        }
      });

      it("a closed ticket's new bottom isn't opened as a PR when pr_open is switched on after the merge (P1c)", async () => {
        let prOff = true;
        const w = world({ policy: { dailyRebase: false }, allow: (k) => !(k === "pr_open" && prOff) });
        const id = await defineAll(w);
        const head = w.mergeOnHub("a", "squash");
        await w.svc.onMerged({ url: "https://github.com/acme/app/pull/1", number: 1, headSha: head, headBranch: "a" }, w.repo);
        expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
        const owned = w.deps.owned;
        let closed = true;
        w.deps.owned = (r, b) => (closed && b === "b" ? null : owned(r, b));
        prOff = false;
        w.advance(60_000);
        await w.svc.tick();
        expect(prCreates()).toEqual([]);
        closed = false;
        w.advance(60_000);
        await w.svc.tick();
        expect(prCreates()).toEqual(["b"]);
      });

      it("a branch whose owner is now a different ticket counts as not live (stack held, no draft, no PR)", async () => {
        const w = world({ policy: { dailyRebase: false } });
        const id = await defineAll(w);
        const owned = w.deps.owned;
        // c 的分支名被别的 ticket 拿去用了
        w.deps.owned = (r, b) => (b === "c" ? { ticketKey: "X", ticketRepoId: 9, ticketTitle: "other", worktree: null } : owned(r, b));
        const before = w.tips(BRANCHES);
        w.pushMain("x.txt", "x\n");
        w.advance(60_000);
        await w.svc.tick();
        expect(w.tips(BRANCHES)).toEqual(before);
        expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred", reason: "ticket closed or archived: c" });
        expect(w.svc.notices().filter((n) => n.reason === "ticket_closed")).toEqual([expect.objectContaining({ branches: ["c"] })]);
        unpushBCD(w);
        expect(await w.svc.setLayerMode(w.repoT.layers(id)[2]!.id, "draft")).toMatchObject({ ok: false });
        expect(prCreates()).toEqual([]);
      });

      it("restoring after taking the closed layer out of the stack restores the rest and says which it skipped (P2)", async () => {
        const w = world({ policy: { dailyRebase: false } });
        const id = await defineAll(w);
        const before = w.tips(BRANCHES);
        w.pushMain("m.txt", "m\n");
        await w.svc.tick();
        const after = w.tips(BRANCHES);
        expect(after).not.toEqual(before);
        const owned = w.deps.owned;
        w.deps.owned = (r, b) => (b === "c" ? null : owned(r, b));
        const r1 = await w.svc.restore(id);
        expect(r1).toMatchObject({ ok: false });
        expect(r1.message).toContain("c ");
        expect((await w.svc.define({ repoPath: w.repo, branches: ["a", "b", "d"], source: "mcp", stackId: id })).ok).toBe(true);
        const r2 = await w.svc.restore(id);
        expect(r2).toMatchObject({ ok: true });
        expect(r2.message).toContain("c");
        // a、b、d 回到备份；c 不动（栈服务不再管它）
        expect(w.tips(BRANCHES)).toEqual([before[0], before[1], after[2], before[3]]);
        expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "restored" });
      });

      it("restoring when every rewritten layer has left the stack does nothing and says so", async () => {
        const w = world({ policy: { dailyRebase: false } });
        const id = await defineAll(w);
        w.pushMain("m.txt", "m\n");
        await w.svc.tick();
        const after = w.tips(BRANCHES);
        // 那次 run 改写的层全不在了：栈换成两个新分支
        g(w.repo, "branch", "e", "a");
        g(w.repo, "branch", "f", "e");
        const owned = w.deps.owned;
        w.deps.owned = (r, b) => (b === "f" ? { ticketKey: "F", ticketRepoId: 1, ticketTitle: null, worktree: null } : owned(r, b));
        expect((await w.svc.define({ repoPath: w.repo, branches: ["e", "f"], source: "mcp", stackId: id })).ok).toBe(true);
        const r = await w.svc.restore(id);
        expect(r).toMatchObject({ ok: false });
        expect(r.message).toContain("a, b, c, d");
        expect(w.tips(BRANCHES)).toEqual(after);
      });

      /** b 带着标记没推，c、d 被它拦住；b 是栈里 id 最大的那层（stack_layers 没有 AUTOINCREMENT，删掉后新层会复用它的 id）。 */
      async function heldByNewestB(w: World): Promise<number> {
        const id = (await w.svc.define({ repoPath: w.repo, branches: ["a", "c", "d"], source: "mcp" })).stackId!;
        expect((await w.svc.define({ repoPath: w.repo, branches: ["a", "b", "c", "d"], source: "mcp", stackId: id })).ok).toBe(true);
        w.repoT.updateLayer(w.repoT.layers(id).find((l) => l.branch === "c")!.id, { baseSha: w.tip("b") });
        amendB(w);
        for (let i = 0; i < 3; i++) {
          w.advance(5 * 60_000);
          await w.svc.tick();
        }
        expect(w.svc.notices().filter((n) => n.reason === "held_below")).toEqual([expect.objectContaining({ branches: ["c", "d"], by: "b" })]);
        return id;
      }

      it("a new layer that reuses the holding layer's id isn't named as holding anything (P3)", async () => {
        // peek：移出 b 以后先看一眼「现在」页（不作数的记录当场删掉）；不看的话旧记录还在，要靠 id + 分支名、markerBlocked 认出来不作数
        for (const [dirty, peek] of [[false, true], [true, true], [false, false], [true, false]] as const) {
          const { st, allow } = offAbove();
          const w = world({ policy: { dailyRebase: false }, allow });
          const id = await heldByNewestB(w);
          const bId = w.repoT.layers(id).find((l) => l.branch === "b")!.id;
          st.cOff = true;
          expect((await w.svc.define({ repoPath: w.repo, branches: ["a", "c", "d"], source: "mcp", stackId: id })).ok).toBe(true);
          if (peek) expect(w.svc.notices().filter((n) => n.reason === "held_below")).toEqual([]);
          // 新分支 e 从 a 开出来，加到 c 下面；dirty 时 e 自己也带着标记（开 draft 时查出来、没推）
          g(w.repo, "branch", "e", "a");
          if (dirty) {
            g(w.repo, "checkout", "-q", "e");
            writeFileSync(join(w.repo, "e.txt"), MARK);
            g(w.repo, "add", "e.txt");
            g(w.repo, "commit", "-q", "-m", "e with markers");
            g(w.repo, "checkout", "-q", "main");
          }
          expect((await w.svc.define({ repoPath: w.repo, branches: ["a", "e", "c", "d"], source: "mcp", stackId: id })).ok).toBe(true);
          const le = w.repoT.layers(id).find((l) => l.branch === "e")!;
          expect(le.id, "e reuses b's id").toBe(bId);
          if (dirty) {
            expect(await w.svc.setLayerMode(le.id, "draft")).toMatchObject({ ok: false });
            expect(w.svc.notices()).toContainEqual(expect.objectContaining({ reason: "markers", branch: "e" }));
          }
          expect(w.svc.notices().filter((n) => n.reason === "held_below"), `dirty ${dirty} peek ${peek}`).toEqual([]);
        }
      });

      it("the holding layer fixed while out of the stack and added back isn't named as holding anything (P3b)", async () => {
        for (const peek of [true, false]) {
          const { st, allow } = offAbove();
          const w = world({ policy: { dailyRebase: false }, allow });
          const id = await heldByNewestB(w);
          const bId = w.repoT.layers(id).find((l) => l.branch === "b")!.id;
          st.cOff = true;
          expect((await w.svc.define({ repoPath: w.repo, branches: ["a", "c", "d"], source: "mcp", stackId: id })).ok).toBe(true);
          if (peek) w.svc.notices();
          amendB(w, "b clean\n");
          expect((await w.svc.define({ repoPath: w.repo, branches: ["a", "b", "c", "d"], source: "mcp", stackId: id })).ok).toBe(true);
          // 加回来的 b 复用了原来的 id、分支名也一样：只有「b 现在没被标记拦着」能认出旧记录不作数
          expect(w.repoT.layers(id).find((l) => l.branch === "b")!.id).toBe(bId);
          const n = w.svc.notices();
          expect(n.filter((x) => x.reason === "held_below"), `peek ${peek}`).toEqual([]);
          expect(n.filter((x) => x.reason === "markers"), `peek ${peek}`).toEqual([]);
        }
      });

      it("a held-back record made during a run survives the Now page being read before the run writes the new tips back", async () => {
        // run 刚结束 c、d 的 force_push 就关了：补推不会再查、再记一次，「被 b 拦住」只能靠 run 里记下的那条
        const { st, allow } = offAbove();
        const w = world({ policy: { dailyRebase: false }, allow });
        const id = await defineAll(w);
        const svc = w.svc as unknown as Spy;
        const real = svc.markersVsRemote.bind(w.svc);
        const running = () => (w.svc as unknown as { running: Set<number> }).running.has(id);
        const calls: string[] = [];
        // run 里每查一层就有人打开一次「现在」页（被拦的层已经记下、新顶端还没写回）
        vi.spyOn(svc, "markersVsRemote").mockImplementation(async (s, l, ...rest) => {
          if (running()) {
            calls.push(l.branch);
            w.svc.notices();
          }
          return real(s, l, ...rest);
        });
        const finish = w.repoT.finishRun.bind(w.repoT);
        vi.spyOn(w.repoT, "finishRun").mockImplementation((...a) => {
          st.cOff = true;
          return finish(...a);
        });
        amendB(w);
        w.advance(5 * 60_000);
        await w.svc.tick();
        expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
        expect(calls).toEqual(expect.arrayContaining(["c", "d"]));
        expect(w.svc.notices().filter((n) => n.reason === "held_below")).toEqual([expect.objectContaining({ branches: ["c", "d"], by: "b" })]);
      });

      it("a layer whose ticket closes in the middle of a run isn't pushed", async () => {
        const w = world({ policy: { dailyRebase: false } });
        const id = await defineAll(w);
        const owned = w.deps.owned;
        let closed = false;
        w.deps.owned = (r, b) => (closed && b === "d" ? null : owned(r, b));
        const svc = w.svc as unknown as Spy;
        const real = svc.markersVsRemote.bind(w.svc);
        // run 开始时还 live（整次推迟的检查过了）；推 b 之前 d 的 ticket 关掉了
        vi.spyOn(svc, "markersVsRemote").mockImplementation(async (s, l, ...rest) => {
          if (l.branch === "b") closed = true;
          return real(s, l, ...rest);
        });
        const remoteD = w.remoteTip("d");
        w.pushMain("x.txt", "x\n");
        w.advance(60_000);
        await w.svc.tick();
        expect(closed).toBe(true);
        expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
        expect(w.tip("d")).not.toBe(remoteD);
        expect(w.remoteTip("d")).toBe(remoteD);
        expect(w.remoteTip("c")).toBe(w.tip("c"));
      });

      it("restoring isn't refused because a merged layer's ticket is closed", async () => {
        const w = world({ policy: { dailyRebase: false } });
        const id = await defineAll(w);
        const before = w.tips(BRANCHES);
        w.pushMain("m.txt", "m\n");
        await w.svc.tick();
        expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
        // a 合并了，它的 ticket 跟着关了
        w.repoT.updateLayer(w.repoT.layers(id)[0]!.id, { state: "merged" });
        const owned = w.deps.owned;
        w.deps.owned = (r, b) => (b === "a" ? null : owned(r, b));
        expect(await w.svc.restore(id)).toMatchObject({ ok: true });
        expect(w.tips(["b", "c", "d"])).toEqual(before.slice(1));
      });

      it("a held-back entry that stopped counting is gone: putting the stack back the way it was doesn't bring the notice back", async () => {
        const { st, allow } = offAbove();
        const w = world({ policy: { dailyRebase: false }, allow });
        const id = await heldByB(w);
        st.cOff = true;
        // c 挪到 b 下面：c 不再算被拦；再挪回来，b 没变、c 没变，也不能凭旧记录又说「c 被 b 拦住」（得重新查过才算）
        expect((await w.svc.define({ repoPath: w.repo, branches: ["a", "c", "b", "d"], source: "mcp", stackId: id })).ok).toBe(true);
        expect(w.svc.notices().filter((n) => n.reason === "held_below")).toEqual([expect.objectContaining({ branches: ["d"], by: "b" })]);
        expect((await w.svc.define({ repoPath: w.repo, branches: ["a", "b", "c", "d"], source: "mcp", stackId: id })).ok).toBe(true);
        expect(w.svc.notices().filter((n) => n.reason === "held_below")).toEqual([expect.objectContaining({ branches: ["d"], by: "b" })]);
      });

      it("a ticket reopened after a deferred daily run resumes at once: the held-back pushes go out (P7)", async () => {
        let off = true;
        const w = world({ policy: { dailyRebase: true }, allow: (k) => !(k === "force_push" && off) });
        const id = await defineAll(w);
        w.pushMain("x.txt", "x\n");
        w.advance(60_000);
        await w.svc.tick();
        expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
        expect(w.repoT.layers(id).every((l) => l.remoteOkSha !== null)).toBe(true);
        const owned = w.deps.owned;
        let closed = true;
        w.deps.owned = (r, b) => (closed && b === "d" ? null : owned(r, b));
        w.advance(24 * 3600_000);
        await w.svc.tick();
        expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred", trigger: "daily", reason: "ticket closed or archived: d" });
        closed = false;
        off = false;
        w.advance(60_000);
        await w.svc.tick();
        expect(w.repoT.lastRun(id)).toMatchObject({ trigger: "daily" });
        expect(w.repoT.lastRun(id)!.outcome).not.toBe("deferred");
        expect(w.remoteTips(BRANCHES)).toEqual(w.tips(BRANCHES));
      });

      it("a manual rebase deferred for a closed ticket reruns as an automatic one once it reopens", async () => {
        const w = world({ policy: { dailyRebase: false } });
        const id = await defineAll(w);
        const owned = w.deps.owned;
        let closed = true;
        w.deps.owned = (r, b) => (closed && b === "d" ? null : owned(r, b));
        // 没有别的触发（trunk、各层都没动）：只有手动点的那一次
        expect((await w.svc.rebaseNow(id)).ok).toBe(false);
        expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "deferred", trigger: "manual" });
        closed = false;
        w.advance(60_000);
        await w.svc.tick();
        const lr = w.repoT.lastRun(id)!;
        expect(lr.trigger).toBe("layer_commits");
        expect(lr.outcome).not.toBe("deferred");
      });

      it("the deferred run records its inputs, and with two closed layers reopening one doesn't rerun it (M3, M5)", async () => {
        const w = world({ policy: { dailyRebase: false } });
        const id = await defineAll(w);
        const owned = w.deps.owned;
        const closed = new Set(["c", "d"]);
        w.deps.owned = (r, b) => (closed.has(b) ? null : owned(r, b));
        w.pushMain("x.txt", "x\n");
        w.advance(60_000);
        await w.svc.tick();
        const lr = w.repoT.lastRun(id)!;
        expect(lr).toMatchObject({ outcome: "deferred", reason: "ticket closed or archived: c, d" });
        expect(lr.detail.inputs).toEqual(expect.any(String));
        // 退避时间内、什么都没变：不重跑
        w.advance(60_000);
        await w.svc.tick();
        expect(w.repoT.lastRun(id)!.id).toBe(lr.id);
        expect(w.repoT.lastRun(id)!.detail.repeats ?? 1).toBe(1);
        closed.delete("c");
        w.advance(60_000);
        await w.svc.tick();
        expect(w.repoT.lastRun(id)!.id).toBe(lr.id);
        expect(w.repoT.lastRun(id)!.detail.repeats ?? 1).toBe(1);
        expect(w.svc.notices().filter((n) => n.reason === "ticket_closed")).toEqual([expect.objectContaining({ branches: ["d"] })]);
        closed.delete("d");
        w.advance(60_000);
        await w.svc.tick();
        expect(w.repoT.lastRun(id)).toMatchObject({ outcome: "rebased" });
      });

      it("the ticket_closed notice lists every closed layer, and shows only with autoRebase on (M23, P4)", async () => {
        const w = world({ policy: { dailyRebase: false } });
        const id = await defineAll(w);
        const owned = w.deps.owned;
        w.deps.owned = (r, b) => (b === "b" || b === "d" ? null : owned(r, b));
        expect(w.svc.notices().filter((n) => n.reason === "ticket_closed")).toEqual([expect.objectContaining({ stackId: id, branch: "b", branches: ["b", "d"], ticketKey: "B" })]);
        w.policy.setLayer({ kind: "global" }, { autoRebase: false, dailyRebase: false });
        expect(w.svc.notices().filter((n) => n.reason === "ticket_closed")).toEqual([]);
        // 手动的被拒时，拒绝的提示说原因
        unpushBCD(w);
        const r = await w.svc.setLayerMode(w.repoT.layers(id)[3]!.id, "draft");
        expect(r).toEqual({ ok: false, message: T().errors.notLive("d") });
      });

      it("a closed layer has only the ticket_closed notice: not its markers, being held, or being rewritten (P5)", async () => {
        const w = world({ policy: { dailyRebase: false } });
        const id = await heldByB(w);
        // 刚自动改写过的层（rewritten 提醒）
        w.pushMain("x.txt", "x\n");
        const before = w.svc.notices().map((n) => `${n.reason}:${n.branch}`);
        expect(before).toEqual(expect.arrayContaining(["markers:b", "held_below:c"]));
        const owned = w.deps.owned;
        for (const dead of ["b", "c"]) {
          w.deps.owned = (r, b) => (b === dead ? null : owned(r, b));
          const n = w.svc.notices().filter((x) => x.stackId === id);
          const ofDead = n.filter((x) => x.reason !== "ticket_closed" && ((x.branches ?? [x.branch]).includes(dead) || x.by === dead));
          expect(ofDead, dead).toEqual([]);
          expect(n.filter((x) => x.reason === "ticket_closed"), dead).toEqual([expect.objectContaining({ branches: [dead] })]);
        }
      });
    });
  });
});
