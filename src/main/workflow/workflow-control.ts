import type { ControlResult } from "../../shared/control";
import type { Feature, Session, Ticket } from "../../shared/types";
import {
  WORKFLOW_PRESETS, WORKFLOW_STEPS, hasStep, parseScopeRef, presetOf, presetWorkflow,
  type Workflow, type WorkflowLayerView, type WorkflowScope,
} from "../../shared/workflow";
import type { WorkflowCoordinatorOp, WorkflowTicketOp } from "../../shared/workflow-control";
import { WF } from "./strings";
import type { WorkflowService } from "./workflow-service";

/**
 * 工作流程的 MCP 工具（BTL-273）：ticket session 的 workflow_step_done，两级总控的 get_workflow、set_workflow、list_workflow_presets。
 * 请求文件谁都能写：from 和作用域在这里重新核对。epic 总控只能改自己的 epic 和它的 ticket；全局总控什么层都能改。
 */
export interface WorkflowControlDeps {
  service: Pick<WorkflowService, "chain" | "layer" | "layers" | "setLayer" | "view" | "summary" | "markStep" | "label">;
  products(): { id: number; name: string }[];
  features: { get(id: number): Feature | null; list(): Feature[] };
  tickets: { get(key: string): Ticket | null; listByFeature(featureId: number): Ticket[] };
  sessions: { head(id: string): Session | null };
}

export type WorkflowCaller = { featureId: number } | { shipherd: true };

const ok = (value: unknown): ControlResult => ({ v: 1, ok: true, value });
const fail = (error: string): ControlResult => ({ v: 1, ok: false, error });
const SLUG = /^[^/\s]+\/[^/\s]+(\/[^/\s]+)?$/;

export function workflowControl(d: WorkflowControlDeps) {
  /** 给总控看的层名：global、product:<名字>、repo:<slug>、epic:<名字>、ticket:<号>。 */
  const scopeText = (s: WorkflowScope): string => (s.kind === "global" ? "global" : `${s.kind === "feature" ? "epic" : s.kind}:${d.service.label(s)}`);

  const layerOut = (l: WorkflowLayerView) => ({ scope: scopeText(l.scope), preset: presetOf(l.workflow), workflow: l.workflow, updatedAt: l.updatedAt });

  const findFeature = (ref: string): Feature | null => {
    const live = d.features.list().filter((f) => f.archivedAt === null);
    if (/^\d+$/.test(ref)) {
      const byId = live.find((f) => f.id === Number(ref));
      if (byId) return byId;
    }
    return live.find((f) => f.name.toLowerCase() === ref.toLowerCase()) ?? null;
  };

  /** scope 字符串 → 层；认不出、找不到返回给总控看的原因。不给 scope 时 epic 总控是它自己的 epic，全局总控是 global。 */
  const resolve = (raw: string | undefined, caller: WorkflowCaller): WorkflowScope | string => {
    if (raw === undefined) return "featureId" in caller ? { kind: "feature", featureId: caller.featureId } : { kind: "global" };
    const r = parseScopeRef(raw);
    if (!r) return WF().ctlBadScope(raw);
    switch (r.kind) {
      case "global":
        return { kind: "global" };
      case "product": {
        const list = d.products();
        const hit = (/^\d+$/.test(r.ref) ? list.find((p) => p.id === Number(r.ref)) : undefined) ?? list.find((p) => p.name.toLowerCase() === r.ref.toLowerCase());
        return hit ? { kind: "product", productId: hit.id } : WF().ctlNoProduct(r.ref, list.map((p) => p.name).join(", "));
      }
      case "repo":
        return SLUG.test(r.ref) ? { kind: "repo", slug: r.ref.toLowerCase() } : WF().ctlBadScope(raw);
      case "feature": {
        const f = findFeature(r.ref);
        return f ? { kind: "feature", featureId: f.id } : WF().ctlNoEpic(r.ref);
      }
      case "ticket": {
        const t = d.tickets.get(r.ref.toUpperCase()) ?? d.tickets.get(r.ref);
        return t && t.archivedAt === null ? { kind: "ticket", ticketKey: t.key } : WF().ctlNoTicket(r.ref);
      }
    }
  };

  /** epic 总控能改的：自己的 epic、自己 epic 里的 ticket。 */
  const mayChange = (s: WorkflowScope, caller: WorkflowCaller): boolean => {
    if ("shipherd" in caller) return true;
    if (s.kind === "feature") return s.featureId === caller.featureId;
    if (s.kind === "ticket") return d.tickets.get(s.ticketKey)?.featureId === caller.featureId;
    return false;
  };

  const ticketOut = (key: string) => {
    const v = d.service.view(key);
    return {
      ticket: key,
      workflow: v.workflow,
      from: v.source ? scopeText(v.source.scope) : null,
      preset: v.preset,
      current: v.current,
      steps: v.steps.map((s) => ({ step: s.id, state: s.state, doneAt: s.doneAt, ...(s.rounds !== undefined && { rounds: s.rounds }) })),
      layers: d.service.chain(key).map(layerOut),
    };
  };

  const get = (req: Extract<WorkflowCoordinatorOp, { op: "get_workflow" }>, caller: WorkflowCaller): ControlResult => {
    if (req.ticket !== undefined) {
      const s = resolve(`ticket:${req.ticket}`, caller);
      return typeof s === "string" ? fail(s) : ok(ticketOut((s as Extract<WorkflowScope, { kind: "ticket" }>).ticketKey));
    }
    // 全局总控不给 scope：列出所有设过的层。
    if (req.scope === undefined && "shipherd" in caller) return ok({ layers: d.service.layers().map(layerOut), presets: [...WORKFLOW_PRESETS] });
    const s = resolve(req.scope, caller);
    if (typeof s === "string") return fail(s);
    if (s.kind === "ticket") return ok(ticketOut(s.ticketKey));
    const own = d.service.layer(s);
    const out: Record<string, unknown> = { scope: scopeText(s), set: own !== null, preset: own ? presetOf(own.workflow) : null, workflow: own?.workflow ?? null, updatedAt: own?.updatedAt ?? null };
    if (s.kind === "feature") {
      // epic：每个 ticket 实际用的哪一层、在哪一步。
      out.tickets = d.tickets.listByFeature(s.featureId).filter((t) => t.archivedAt === null).map((t) => ({ ticket: t.key, ...(d.service.summary(t.key) ?? { source: null }) }));
    }
    return ok(out);
  };

  const set = (req: Extract<WorkflowCoordinatorOp, { op: "set_workflow" }>, caller: WorkflowCaller): ControlResult => {
    const s = resolve(req.scope, caller);
    if (typeof s === "string") return fail(s);
    if (!mayChange(s, caller)) return fail(WF().ctlNotYours);
    const raw = req.steps === null ? null : { steps: req.steps, notes: req.notes ?? "" };
    const r = d.service.setLayer(s, raw);
    if (!r.ok) return fail(r.message);
    const text = scopeText(s);
    const note = !r.changed ? WF().ctlUnchanged : r.workflow ? WF().ctlSet(text) : WF().ctlCleared(text);
    // 没有合并这一步：由用户自己合，总控也不能合（闸门照这个拦），这里说清楚。
    const noMerge = r.workflow !== null && !hasStep(r.workflow, "merge");
    return ok({ scope: text, changed: r.changed, workflow: r.workflow, preset: r.workflow ? presetOf(r.workflow) : null, note: noMerge ? `${note}${WF().noMergeStep}` : note });
  };

  const presets = (): ControlResult => {
    const s = WF();
    return ok({
      presets: WORKFLOW_PRESETS.map((id) => ({ id, workflow: presetWorkflow(id) as Workflow })),
      steps: WORKFLOW_STEPS.map((id) => ({ id, name: s.step(id), what: s.stepHelp[id] })),
      note: s.ctlPresetsNote,
    });
  };

  return {
    /** 两级总控的 get / set / list_workflow_presets。 */
    coordinator(req: WorkflowCoordinatorOp, caller: WorkflowCaller): ControlResult {
      if (req.op === "list_workflow_presets") return presets();
      if (req.op === "get_workflow") return get(req, caller);
      return set(req, caller);
    },
    /** ticket session 的 workflow_step_done：调用的必须是这个 ticket 自己的 session。 */
    ticketStep(req: WorkflowTicketOp & { from: string | null }, t: Ticket): ControlResult {
      const h = req.from ? d.sessions.head(req.from) : null;
      if (!h || h.ticketKey !== t.key) return fail(WF().ctlNotYourSession);
      const r = d.service.markStep(t.key, req.step, req.note ?? null);
      return r.ok ? ok({ note: r.message, current: d.service.view(t.key).current }) : fail(r.message);
    },
    /** list_tickets 的 workflow 字段：没有流程是 null；读坏了也是 null（不让整张列表失败）。 */
    summary(key: string): ReturnType<WorkflowService["summary"]> {
      try {
        return d.service.summary(key);
      } catch {
        return null;
      }
    },
  };
}

export type WorkflowControl = ReturnType<typeof workflowControl>;
