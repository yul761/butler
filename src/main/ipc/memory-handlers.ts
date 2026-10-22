import type { MemoryView, WhyEntry } from "../../shared/memory";
import { ticketScope } from "../../shared/memory";
import type { TicketsRepo } from "../db/tickets-repo";
import type { MemoryService } from "../memory/memory-service";
import { factIdArg, ticketKeyArg } from "./validate";

interface Deps {
  tickets: Pick<TicketsRepo, "get">;
  memory: Pick<MemoryService, "view" | "why">;
  /** 设置里的记忆开关。 */
  enabled: () => boolean;
}

/** 记忆 IPC（设计文档 8.4）：只读；key 不是已知 ticket 时不碰 StateCore（否则会凭空建出一个 scope）。 */
export function memoryHandlers(d: Deps): {
  view: (key: unknown) => Promise<MemoryView>;
  why: (key: unknown, factId: unknown) => Promise<WhyEntry[] | null>;
} {
  return {
    async view(key) {
      const k = ticketKeyArg(key);
      if (!d.tickets.get(k)) return { enabled: d.enabled(), scope: ticketScope(k), handoff: null, items: [], error: null };
      return d.memory.view(k);
    },
    async why(key, factId) {
      const k = ticketKeyArg(key);
      const id = factIdArg(factId);
      if (!d.tickets.get(k)) return null;
      return d.memory.why(k, id);
    },
  };
}
