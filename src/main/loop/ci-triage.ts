import type { CiTriageRepo, TriageRow } from "../db/ci-triage-repo";
import type { ExternalActions } from "../external/actions";
import type { CiItem } from "../prwatch/ci-delivery";
import type { CiCheck } from "../tickets/gh";
import type { GhWrite, RunInfo } from "../tickets/gh-loop";
import type { LoopPolicy } from "../../shared/loop-policy";
import { M } from "../strings";
import { classifyCiByRule, failedStep, failedTests, failureSignature, type CiVerdict } from "./ci-rules";
import type { CiModelInput } from "./ci-model";
import { safeRecord, type RecordEvent } from "./metrics";

/**
 * CI 失败分类和自动重跑（工作流 I，设计补充第 4 节）。CiDelivery 递一条失败的结论之前问 decide：
 * 原样递、递并附上 Butler 的判断、或者先不递（在分类、刚重跑、在等重跑的结果）。要调 gh 或模型时 decide 先返回 hold，
 * 后台做完调 wake(item) 让 CiDelivery 重新问。状态都在 ci_triage 里，重启不丢。
 */

export const CI_TRIAGE_GH_TIMEOUT_MS = 30_000;
/** 失败日志取多少行（和 PrWatcher 的 CI_LOG_LINES 一样）。 */
export const CI_TRIAGE_LOG_LINES = 60;
/** 在等重跑结果时，最多这么久问一次 gh run view。 */
export const RERUN_CHECK_MS = 30_000;
/** 重跑之后这么久还没有结果：不再等，按代码问题递。 */
export const RERUN_GIVE_UP_MS = 6 * 3600_000;
/** 重跑通过以后，PrWatcher 可能还拿着旧的失败结论：这么久之内先不递（之后再失败按新的失败递）。 */
export const PASSED_GRACE_MS = 10 * 60_000;

export interface TriageWhere {
  cwd: string;
  slug: string | null;
  ticketKey: string;
  prId: number | null;
  /** 审计里的目标：PR 链接，分支行为 null。 */
  target: string | null;
}

export interface CiTriageDeps {
  repo: CiTriageRepo;
  policy(slug: string | null): LoopPolicy;
  external: Pick<ExternalActions, "attempt">;
  gh: {
    runInfo(cwd: string, runId: number, timeoutMs: number, repo?: string | null): Promise<RunInfo | null>;
    failedLog(cwd: string, runId: number, lines: number, timeoutMs: number, repo?: string | null): Promise<string | null>;
    rerunFailed(cwd: string, runId: number, timeoutMs: number, repo?: string | null): Promise<GhWrite>;
  };
  /** 后台模型（ci_classify）；失败返回 null。 */
  model(input: CiModelInput): Promise<{ category: "env" | "code"; reason: string } | null>;
  where(item: CiItem): TriageWhere | null;
  /** 分类或重跑有了结果：让 CiDelivery 重新问一次。 */
  wake(item: CiItem): void;
  /** 刚触发了重跑：马上重读这个条目（PrWatcher.soon）。 */
  soon(item: CiItem): void;
  recordEvent: RecordEvent;
  /** 过一会儿再叫一次（在等重跑结果时用）；默认 setTimeout + unref。 */
  later?(ms: number, f: () => void): void;
  now(): number;
  log(msg: string, err?: unknown): void;
}

export type TriageDecision = { action: "deliver"; note: string | null; onSent?: () => void } | { action: "hold"; reason: string };

/** 一个 run 现在的结论。 */
type RunState =
  | { kind: "pending" }
  | { kind: "deliver"; row: TriageRow | null; outcome: string; note: string | null };

const ref = (item: CiItem): { kind: "pr" | "branch"; id: number } => (item.kind === "pr" ? { kind: "pr", id: item.id } : { kind: "branch", id: item.repoId });
const itemKey = (item: CiItem): string => (item.kind === "pr" ? `pr:${item.id}` : `branch:${item.repoId}`);

export class CiTriage {
  /** 正在后台处理的行（分类、重跑、查重跑结果）。 */
  private readonly inflight = new Set<number>();
  /** 每一行上一次问 gh run view 的时间。 */
  private readonly checkedAt = new Map<number, number>();
  /** 已经排了定时器的行。 */
  private readonly timers = new Set<number>();

  constructor(private readonly d: CiTriageDeps) {}

  /** CiDelivery 递一条结论之前问它。row 是 PR 行或分支行这一轮读到的。 */
  decide(item: CiItem, row: { headSha: string | null; ci: string; failed: CiCheck[] }): TriageDecision {
    const deliver: TriageDecision = { action: "deliver", note: null };
    const w = this.d.where(item);
    if (!w || row.headSha === null) return deliver;
    let policy: LoopPolicy;
    try {
      policy = this.d.policy(w.slug);
    } catch (e) {
      this.d.log("ci triage: reading the policy failed", e);
      return deliver;
    }
    if (!policy["ci.enabled"]) return deliver;
    const sha = row.headSha;
    try {
      if (row.ci === "passing") {
        for (const r of this.d.repo.atSha(ref(item), sha)) if (r.state === "rerunning" || (r.state === "classified" && r.reruns > 0)) this.passed(item, r, w);
        return deliver;
      }
      if (row.ci !== "failing") return deliver;
      this.d.repo.abandonOthers(ref(item), sha, this.d.now());
      return this.decideFailing(item, row.failed, sha, w, policy);
    } catch (e) {
      this.d.log(`ci triage ${itemKey(item)}: failed, delivering as is`, e);
      return deliver;
    }
  }

  private decideFailing(item: CiItem, failed: CiCheck[], sha: string, w: TriageWhere, policy: LoopPolicy): TriageDecision {
    const runs = new Map<number, CiCheck[]>();
    let external = false;
    for (const c of failed) {
      if (c.state !== "failing") continue;
      if (c.runId === null) external = true;
      else (runs.get(c.runId) ?? runs.set(c.runId, []).get(c.runId)!).push(c);
    }
    // 不是 GitHub Actions 的检查（外部的 status）重跑不了：按代码问题递。
    if (external || runs.size === 0) return { action: "deliver", note: null, onSent: () => this.markDelivered(item, sha, "code") };
    const states: RunState[] = [];
    for (const [runId, checks] of runs) {
      const row = this.d.repo.create({ item: ref(item), repoSlug: w.slug, ticketKey: w.ticketKey, headSha: sha, runId, checks: checks.map((c) => c.name), now: this.d.now() });
      states.push(this.runState(item, row, checks, w, policy));
    }
    const delivers = states.filter((s): s is Extract<RunState, { kind: "deliver" }> => s.kind === "deliver");
    // 有一个是代码问题就马上递（重跑别的也救不了）；全都还在处理就先不递。
    if (delivers.length === 0) return { action: "hold", reason: "triage" };
    const notes = [...new Set(delivers.map((s) => s.note).filter((n): n is string => n !== null))];
    const outcomes = new Map(delivers.filter((s) => s.row).map((s) => [s.row!.id, s.outcome]));
    return { action: "deliver", note: notes.length > 0 ? notes.join("\n") : null, onSent: () => this.markDelivered(item, sha, "code", outcomes) };
  }

  private runState(item: CiItem, row: TriageRow, checks: CiCheck[], w: TriageWhere, policy: LoopPolicy): RunState {
    const m = M();
    switch (row.state) {
      case "classifying":
        if (!this.inflight.has(row.id)) this.background(row.id, () => this.classify(item, row, checks.find((c) => c.log)?.log ?? null, w, policy, null));
        return { kind: "pending" };
      case "rerunning": {
        if (this.d.now() - (row.rerunAt ?? row.updatedAt) > RERUN_GIVE_UP_MS) {
          this.d.repo.update(row.id, { state: "classified", outcome: "rerun_lost" }, this.d.now());
          return { kind: "deliver", row, outcome: "rerun_lost", note: m.ciTriageRerunLost(row.reruns) };
        }
        const last = this.checkedAt.get(row.id) ?? 0;
        const due = RERUN_CHECK_MS - (this.d.now() - last);
        if (!this.inflight.has(row.id) && due <= 0) {
          this.checkedAt.set(row.id, this.d.now());
          this.background(row.id, () => this.checkRerun(item, row, w, policy));
        }
        // 没有别的东西会再问 decide 时（PR 的结论没变），自己过一会儿再看一次。
        this.schedule(item, row.id, Math.max(due, 0) + RERUN_CHECK_MS);
        return { kind: "pending" };
      }
      case "passed":
        if (row.passedAt !== null && this.d.now() - row.passedAt < PASSED_GRACE_MS) return { kind: "pending" };
        return { kind: "deliver", row, outcome: "code", note: null };
      case "classified": {
        const reason = row.reason ?? "";
        if (row.category === "code" || row.category === null) return { kind: "deliver", row, outcome: "code", note: null };
        if (row.outcome === "rerun_off") return { kind: "deliver", row, outcome: "rerun_off", note: m.ciTriageRerunOff(reason) };
        if (row.outcome === "rerun_failed") return { kind: "deliver", row, outcome: "rerun_failed", note: m.ciTriageRerunFailed(reason) };
        if (row.outcome === "rerun_lost") return { kind: "deliver", row, outcome: "rerun_lost", note: m.ciTriageRerunLost(row.reruns) };
        if (row.prevSignature !== null && row.signature === row.prevSignature) {
          return { kind: "deliver", row, outcome: "same_twice", note: m.ciTriageSameTwice(reason, row.category === "flaky") };
        }
        if (row.reruns >= policy["ci.maxReruns"]) return { kind: "deliver", row, outcome: "possibly_flaky", note: m.ciTriagePossiblyFlaky(reason, row.reruns) };
        if (!this.inflight.has(row.id)) this.background(row.id, () => this.rerun(item, row, w));
        return { kind: "pending" };
      }
      // 已经递过、通过了的：这次又失败（例如有人手动重跑了），照常递。
      default:
        return { kind: "deliver", row, outcome: "code", note: null };
    }
  }

  private schedule(item: CiItem, id: number, ms: number): void {
    if (this.timers.has(id)) return;
    this.timers.add(id);
    const fire = (): void => {
      this.timers.delete(id);
      this.d.wake(item);
    };
    if (this.d.later) this.d.later(ms, fire);
    else setTimeout(fire, ms).unref?.();
  }

  private background(id: number, f: () => Promise<void>): void {
    this.inflight.add(id);
    void f()
      .catch((e: unknown) => this.d.log(`ci triage: row ${id} failed`, e))
      .finally(() => this.inflight.delete(id));
  }

  /** 分类一个失败的 run（第一次，或重跑以后又失败了：prevSignature 是上一次的签名）。 */
  private async classify(item: CiItem, row: TriageRow, rowLog: string | null, w: TriageWhere, policy: LoopPolicy, after: { info: RunInfo; prevSignature: string | null } | null): Promise<void> {
    const info = after?.info ?? (await this.d.gh.runInfo(w.cwd, row.runId, CI_TRIAGE_GH_TIMEOUT_MS, w.slug));
    // 重跑以后的日志一定要重新取；第一次用 PrWatcher 这一轮取到的，没有才取。
    const log = after || rowLog === null ? await this.d.gh.failedLog(w.cwd, row.runId, CI_TRIAGE_LOG_LINES, CI_TRIAGE_GH_TIMEOUT_MS, w.slug) : rowLog;
    const f = { runId: row.runId, checks: row.checks, log, info };
    const flaky = [...policy["ci.flakyTests"], ...(w.slug ? this.d.repo.listed(w.slug) : [])];
    let verdict: CiVerdict | null = classifyCiByRule(f, { envPatterns: policy["ci.envPatterns"], codePatterns: policy["ci.codePatterns"], flaky });
    if (!verdict && policy["ci.useModel"] && log) {
      const m = await this.d.model({ cwd: w.cwd, checks: row.checks, step: failedStep(f), log });
      if (m) verdict = { category: m.category, source: "model", reason: m.reason };
    }
    verdict ??= { category: "code", source: "fallback", reason: policy["ci.useModel"] ? "model_unavailable" : "no_rule" };
    const now = this.d.now();
    this.d.repo.update(row.id, {
      state: "classified", category: verdict.category, source: verdict.source, reason: verdict.reason, signature: failureSignature(row.checks, log),
      prevSignature: after?.prevSignature ?? null, tests: failedTests(log), attempt: info?.attempt ?? row.attempt, outcome: null,
    }, now);
    this.d.log(`ci triage ${itemKey(item)} run ${row.runId}: ${verdict.category} (${verdict.source}: ${verdict.reason})`);
    this.d.wake(item);
  }

  /** 触发重跑（对外动作 ci_rerun，开关关着记 skipped）。 */
  private async rerun(item: CiItem, row: TriageRow, w: TriageWhere): Promise<void> {
    const detail = {
      scope: { repoSlug: w.slug ?? undefined, ticketKey: w.ticketKey },
      target: w.target ?? undefined,
      summary: `rerun failed jobs of run ${row.runId} (${row.checks.join(", ")}): ${row.category} – ${row.reason ?? ""}`.slice(0, 300),
      payload: JSON.stringify({ runId: row.runId, attempt: row.attempt, checks: row.checks, category: row.category, reason: row.reason, reruns: row.reruns }),
    };
    let outcome: "rerun_off" | "rerun_failed" | null = null;
    try {
      const r = await this.d.external.attempt("ci_rerun", detail, async () => {
        const out = await this.d.gh.rerunFailed(w.cwd, row.runId, CI_TRIAGE_GH_TIMEOUT_MS, w.slug);
        if (!out.ok) throw new Error(out.error);
      });
      if (!r.ran) outcome = "rerun_off";
    } catch (e) {
      this.d.log(`ci triage ${itemKey(item)}: rerunning run ${row.runId} failed`, e);
      outcome = "rerun_failed";
    }
    const now = this.d.now();
    if (outcome) {
      this.d.repo.update(row.id, { outcome }, now);
    } else {
      this.d.repo.update(row.id, { state: "rerunning", reruns: row.reruns + 1, rerunAttempt: row.attempt, rerunAt: now }, now);
      this.checkedAt.set(row.id, now);
      safeRecord(this.d.recordEvent, "ci_rerun", {
        ticketKey: w.ticketKey, prId: w.prId, repoSlug: w.slug, dedupeKey: `ci_rerun:${row.id}:${row.reruns + 1}`,
        data: { category: row.category, source: row.source, attempt: row.attempt, reruns: row.reruns + 1 },
      }, this.d.log);
      this.d.log(`ci triage ${itemKey(item)}: reran run ${row.runId} (${row.reruns + 1})`);
      this.d.soon(item);
    }
    this.d.wake(item);
  }

  /** 在等重跑：attempt 变大而且跑完了才算有结果。通过了算一次 flaky；又失败了重新分类（带上一次的签名）。 */
  private async checkRerun(item: CiItem, row: TriageRow, w: TriageWhere, policy: LoopPolicy): Promise<void> {
    const info = await this.d.gh.runInfo(w.cwd, row.runId, CI_TRIAGE_GH_TIMEOUT_MS, w.slug);
    if (!info || info.attempt <= (row.rerunAttempt ?? row.attempt) || info.status !== "completed") return;
    if (info.conclusion === "success") {
      const fresh = this.d.repo.byId(row.id);
      if (fresh && fresh.state === "rerunning") this.passed(item, fresh, w);
      this.d.wake(item);
      return;
    }
    await this.classify(item, row, null, w, policy, { info, prevSignature: row.signature });
  }

  /** 重跑以后通过了：记 flaky（检查名和认出的测试名各一条）、浪费的时间，次数够了自动列入名单。 */
  private passed(item: CiItem, row: TriageRow, w: TriageWhere): void {
    const now = this.d.now();
    const wasted = Math.max(0, now - row.firstFailedAt);
    this.d.repo.update(row.id, { state: "passed", passedAt: now, outcome: "passed" }, now);
    const slug = w.slug ?? "";
    const policy = this.d.policy(w.slug);
    const since = now - policy["ci.autoListDays"] * 86_400_000;
    const names: { kind: "check" | "test"; name: string }[] = [...row.checks.map((name) => ({ kind: "check" as const, name })), ...row.tests.map((name) => ({ kind: "test" as const, name }))];
    for (const n of names) {
      this.d.repo.addFlaky({ repoSlug: slug, kind: n.kind, name: n.name, triageId: row.id, at: now, wastedMs: wasted });
      if (this.d.repo.flakyCount(slug, n.kind, n.name, since) >= policy["ci.autoListThreshold"] && this.d.repo.list(slug, n.kind, n.name, "auto", now)) {
        this.d.log(`ci triage: ${n.kind} ${n.name} in ${slug || "(unknown repo)"} is flaky; listed automatically`);
      }
    }
    safeRecord(this.d.recordEvent, "ci_flaky", {
      ticketKey: w.ticketKey, prId: w.prId, repoSlug: w.slug, dedupeKey: `ci_flaky:${row.id}`,
      data: { checks: row.checks.join(", "), tests: row.tests.length, wastedMs: wasted, reruns: row.reruns },
    }, this.d.log);
    this.d.log(`ci triage ${itemKey(item)}: run ${row.runId} passed after ${row.reruns} rerun(s); ${Math.round(wasted / 1000)}s lost to flakiness`);
  }

  /** 结论递出去了：这个 sha 上还没处理完的行都标成已递。 */
  private markDelivered(item: CiItem, sha: string, fallback: string, outcomes?: Map<number, string>): void {
    const now = this.d.now();
    try {
      for (const r of this.d.repo.atSha(ref(item), sha)) {
        if (r.state === "passed" || r.state === "delivered" || r.state === "abandoned") continue;
        this.d.repo.update(r.id, { state: "delivered", deliveredAt: now, outcome: outcomes?.get(r.id) ?? r.outcome ?? fallback }, now);
      }
    } catch (e) {
      this.d.log(`ci triage ${itemKey(item)}: marking delivered failed`, e);
    }
  }
}
