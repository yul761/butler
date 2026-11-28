import { parseWorkflowScope, type FeatureWorkflowView, type TicketWorkflowView, type WorkflowSetResult, type WorkflowSettingsView } from "../../shared/workflow";
import type { Feature, Ticket } from "../../shared/types";
import { WF } from "./strings";
import type { WorkflowService } from "./workflow-service";

/**
 * 工作流程的界面通道（BTL-273）：设置页的分层编辑、epic 页和 ticket 首页的流程条。
 * 参数都是渲染进程给的：作用域和流程在这里重新解析，错了返回能显示的原因，不抛。
 */
export interface WorkflowIpcDeps {
  service: Pick<WorkflowService, "layers" | "setLayer" | "view" | "summary" | "layer">;
  products(): { id: number; name: string }[];
  features: { list(): Feature[] };
  tickets: { list(): Ticket[]; get(key: string): Ticket | null };
  slugOf(path: string): string | null;
}

export function workflowHandlers(d: WorkflowIpcDeps) {
  const open = () => d.tickets.list().filter((t) => t.archivedAt === null);
  return {
    state(): WorkflowSettingsView {
      const live = open();
      const repos = new Set<string>();
      for (const t of live) for (const r of t.repos) {
        const s = d.slugOf(r.repoPath);
        if (s) repos.add(s.toLowerCase());
      }
      return {
        layers: d.service.layers(),
        targets: {
          products: d.products(),
          repos: [...repos].sort(),
          features: d.features.list().filter((f) => f.archivedAt === null).map((f) => ({ id: f.id, name: f.name })),
          tickets: live.map((t) => ({ key: t.key, title: t.title })),
        },
      };
    },
    set(rawScope: unknown, rawWorkflow: unknown): WorkflowSetResult {
      const scope = parseWorkflowScope(rawScope);
      if (!scope) return { ok: false, message: WF().uiBadScope };
      const r = d.service.setLayer(scope, rawWorkflow ?? null);
      return r.ok ? { ok: true, changed: r.changed } : { ok: false, message: r.message };
    },
    ticket(raw: unknown): TicketWorkflowView | null {
      if (typeof raw !== "string" || !d.tickets.get(raw)) return null;
      return d.service.view(raw);
    },
    feature(raw: unknown): FeatureWorkflowView | null {
      if (!Number.isInteger(raw)) return null;
      const featureId = raw as number;
      const tickets = open().filter((t) => t.featureId === featureId).flatMap((t) => {
        const s = d.service.summary(t.key);
        return s ? [{ key: t.key, current: s.current, done: s.done, total: s.total }] : [];
      });
      return { featureId, own: d.service.layer({ kind: "feature", featureId })?.workflow ?? null, tickets };
    },
  };
}
