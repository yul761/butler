import type { EpicsRepo } from "../db/epics-repo";
import type { FeaturesRepo } from "../db/features-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { M } from "../strings";

export interface WhoDeps {
  tickets: Pick<TicketsRepo, "get">;
  features: Pick<FeaturesRepo, "get">;
  epics: Pick<EpicsRepo, "get">;
}

/**
 * 合并总控文案里的“谁”（MergeGate 和 HoldWatcher 共用）：`KEY（epic 名 / feature 名）`、`KEY（feature 名）`、独立 ticket 只有号码；
 * 没有 ticket 时用 branch 名。每次现查：feature 改名、挪进 epic 之后说的就是新名字。
 */
export function makeWhoOf(d: WhoDeps): (ticketKey: string | null, branch: string) => string {
  return (ticketKey, branch) => {
    if (ticketKey === null) return branch;
    const t = d.tickets.get(ticketKey);
    const f = t && t.featureId !== null ? d.features.get(t.featureId) : null;
    const e = f && f.epicId !== null ? d.epics.get(f.epicId) : null;
    const within = [e?.name, f?.name].filter((n): n is string => Boolean(n));
    return M().gateWho(ticketKey, within);
  };
}
