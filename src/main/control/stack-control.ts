import { basename } from "node:path";
import type { ControlResult, StackControlOp } from "../../shared/control";
import type { StackView } from "../../shared/stacks";
import type { Feature, Ticket } from "../../shared/types";
import type { StackService } from "../stacks/stack-service";
import { T } from "../stacks/pr-text";
import { samePath } from "../tickets/ticket-service";

/** 谁在问：feature 总控、Shipherd 总控。 */
export type StackScope = { kind: "feature"; featureId: number } | { kind: "shipherd" };

export interface StackControlDeps {
  service: Pick<StackService, "define" | "view" | "rebaseNow" | "setLayerMode" | "canStackOn" | "stackOn">;
  /** 没归档的 ticket（带仓库）。 */
  tickets: () => Ticket[];
  features: { get(id: number): Feature | null; list(): Feature[] };
}

const ok = (value: unknown): ControlResult => ({ v: 1, ok: true, value });
const fail = (error: string): ControlResult => ({ v: 1, ok: false, error });
const iso = (t: number | null): string | null => (t ? new Date(t).toISOString() : null);

/** 给模型看的栈：只留常用的字段。 */
export function stackOut(s: StackView): object {
  return {
    id: s.id, name: s.name, repo: s.repoPath, trunk: s.trunk, autoRebase: s.autoRebase, source: s.source,
    layers: s.layers.map((l) => ({
      branch: l.branch, ticket: l.ticketKey, state: l.state, mode: l.mode, pr: l.prUrl, behind: l.behind, unpushed: l.unpushed, lastRebaseAt: iso(l.lastRebaseAt),
    })),
    lastRun: s.lastRun ? { outcome: s.lastRun.outcome, reason: s.lastRun.reason, conflict: s.lastRun.conflict, at: iso(s.lastRun.startedAt) } : null,
  };
}

/**
 * 栈的 MCP 工具（工作流 K，设计文档第 2.2 节）：list_stacks、stack_define、stack_rebase、stack_layer_mode，
 * 外加 create_ticket 的 stack_on。feature 总控只看得到、只动得了自己 feature 的栈（栈的 feature 是它，或者某层是它的 ticket）。
 */
export class StackControl {
  constructor(private readonly d: StackControlDeps) {}

  private scopeTickets(scope: StackScope): Ticket[] {
    const all = this.d.tickets();
    if (scope.kind === "shipherd") return all;
    return all.filter((t) => t.featureId === scope.featureId);
  }

  /**
   * 看：栈是它的（feature 对得上），或者有一层是它的 ticket。
   * 改（write）：栈是它的，或者每一层都是它的 ticket——别的 feature 的层不能借一层共有的就被 rebase、force push。
   */
  private belongs(scope: StackScope, s: StackView, keys: Set<string>, write = false): boolean {
    if (scope.kind === "shipherd") return true;
    if (scope.kind === "feature" && s.featureId === scope.featureId) return true;
    const mine = (l: StackView["layers"][number]) => l.ticketKey !== null && keys.has(l.ticketKey);
    return write ? s.layers.filter((l) => l.state !== "merged").every(mine) : s.layers.some(mine);
  }

  private async mine(scope: StackScope): Promise<StackView[]> {
    const keys = new Set(this.scopeTickets(scope).map((t) => t.key));
    const v = await this.d.service.view({ featureId: null });
    return v.stacks.filter((s) => this.belongs(scope, s, keys));
  }

  /** 要改的那个栈（只有改的操作用它）。 */
  private async one(scope: StackScope, id: number): Promise<StackView | string> {
    const all = await this.d.service.view({ featureId: null });
    const s = all.stacks.find((x) => x.id === id);
    if (!s) return T().errors.notFound;
    const keys = new Set(this.scopeTickets(scope).map((t) => t.key));
    return this.belongs(scope, s, keys, true) ? s : T().errors.notYours;
  }

  async handle(scope: StackScope, req: StackControlOp): Promise<ControlResult> {
    if (req.op === "list_stacks") return ok((await this.mine(scope)).map(stackOut));
    if (req.op === "stack_define") return this.define(scope, req);
    const s = await this.one(scope, req.stack);
    if (typeof s === "string") return fail(s);
    if (req.op === "stack_rebase") {
      // 总控调的就是总控确认的（BTL-278），和用户在界面上点的分开记
      const r = await this.d.service.rebaseNow(s.id, scope.kind === "feature" ? "coordinator" : "shipherd");
      if (!r.ok) return fail(r.message);
      return ok({ result: r.message ?? null, stack: await this.after(s.id) });
    }
    const layer = s.layers.find((l) => l.branch === req.branch.trim());
    if (!layer) return fail(T().errors.layerNotFound);
    const r = await this.d.service.setLayerMode(layer.id, req.mode);
    if (!r.ok) return fail(r.message);
    return ok({ result: r.message ?? null, stack: await this.after(s.id) });
  }

  private async after(id: number): Promise<object | null> {
    const v = await this.d.service.view({ featureId: null });
    const s = v.stacks.find((x) => x.id === id);
    return s ? stackOut(s) : null;
  }

  private async define(scope: StackScope, req: Extract<StackControlOp, { op: "stack_define" }>): Promise<ControlResult> {
    const e = T().errors;
    const tickets = this.scopeTickets(scope);
    const feature = scope.kind === "feature" ? this.d.features.get(scope.featureId) : null;
    if (req.stack !== undefined) {
      const s = await this.one(scope, req.stack);
      if (typeof s === "string") return fail(s);
    }
    const candidates = scope.kind === "feature"
      ? (feature?.repos.map((r) => r.repoPath) ?? [])
      : [...new Map(tickets.flatMap((t) => t.repos).map((r) => [r.repoPath, r.repoPath])).values()];
    const names = candidates.map((p) => basename(p)).join(", ") || "-";
    const asTicket = (x: string) => tickets.find((t) => t.key === x.trim().toUpperCase()) ?? null;

    let repoPath: string | null = null;
    if (req.repo !== undefined) {
      const w = req.repo.trim();
      const byPath = candidates.find((p) => samePath(p, w));
      const byName = candidates.filter((p) => basename(p).toLowerCase() === w.toLowerCase());
      repoPath = byPath ?? (byName.length === 1 ? byName[0]! : null);
      if (!repoPath) return fail(e.noSuchRepo(w, names));
    } else if (candidates.length === 1) {
      repoPath = candidates[0]!;
    } else {
      // 都没给：从 ticket 号推（这些 ticket 共有、而且只有一个的仓库）
      const given = req.branches.map(asTicket).filter((t): t is Ticket => t !== null);
      const common = given.length === 0 ? [] : candidates.filter((p) => given.every((t) => t.repos.some((r) => samePath(r.repoPath, p))));
      if (common.length !== 1) return fail(e.needRepo(names));
      repoPath = common[0]!;
    }

    const branches: string[] = [];
    const layerTickets: Ticket[] = [];
    for (const raw of req.branches) {
      const t = asTicket(raw);
      if (t) {
        const r = t.repos.find((x) => samePath(x.repoPath, repoPath!));
        if (!r) return fail(e.ticketNoRepo(t.key, basename(repoPath)));
        branches.push(r.branch);
        layerTickets.push(t);
      } else {
        const b = raw.trim();
        const owner = tickets.find((x) => x.repos.some((r) => r.branch === b && samePath(r.repoPath, repoPath!)));
        // feature 总控只能用自己 feature 的 ticket 的分支（Shipherd 总控可以用任何 Shipherd 分支，service 会再核对）
        if (!owner && scope.kind === "feature") return fail(e.notYours);
        branches.push(b);
        if (owner) layerTickets.push(owner);
      }
    }
    // Shipherd 总控建的：各层的 ticket 都在同一个 feature 里就记上它
    let featureId: number | null = feature?.id ?? null;
    if (scope.kind === "shipherd") {
      const fids = new Set(layerTickets.map((t) => t.featureId));
      const only = fids.size === 1 ? [...fids][0]! : null;
      featureId = only ?? null;
    }
    const r = await this.d.service.define({
      repoPath, branches, name: req.name ?? null, featureId, source: "mcp", stackId: req.stack ?? null,
    });
    if (!r.ok) return fail(r.message);
    return ok({ stack: r.stackId ? await this.after(r.stackId) : null });
  }

  /**
   * create_ticket 的 stack_on，建 worktree 之前：parent 是同一个 feature 里的 ticket，新 ticket 的每个仓库 parent 都要有，
   * 而且 parent 的分支在那个仓库里是栈顶（或者还不在栈里）。返回每个仓库从哪个分支开出来。
   */
  prepareStackOn(featureId: number, parentKey: string, repoPaths: string[]): { startPoints: { repoPath: string; ref: string }[] } | { error: string } {
    const e = T().errors;
    const parent = this.d.tickets().find((t) => t.featureId === featureId && t.key === parentKey.trim().toUpperCase());
    if (!parent) return { error: e.stackOnNoTicket(parentKey) };
    const startPoints: { repoPath: string; ref: string }[] = [];
    for (const p of repoPaths) {
      const r = parent.repos.find((x) => samePath(x.repoPath, p));
      if (!r) return { error: e.stackOnRepo(parent.key, basename(p)) };
      const can = this.d.service.canStackOn(r.repoPath, r.branch);
      if (!can.ok) return { error: can.message };
      startPoints.push({ repoPath: p, ref: r.branch });
    }
    return { startPoints };
  }

  /** ticket 建好以后：每个仓库的新分支接到 parent 分支的栈顶上。返回没接上的原因（都接上了为空）。 */
  async finishStackOn(f: Feature, t: Ticket, startPoints: { repoPath: string; ref: string }[]): Promise<string[]> {
    const problems: string[] = [];
    for (const sp of startPoints) {
      const r = t.repos.find((x) => samePath(x.repoPath, sp.repoPath));
      if (!r) continue;
      const res = await this.d.service.stackOn({ repoPath: r.repoPath, parentBranch: sp.ref, branch: r.branch, featureId: f.id });
      if (!res.ok) problems.push(T().errors.stackOnFailed(res.message));
    }
    return problems;
  }
}
