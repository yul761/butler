import type { ConvMessage, ConvPage } from "../../shared/conversation";
import type { ConversationStore } from "../conversation/conversation-store";
import { convListOptsArg, convQueryArg, convRootArg, sessionIdArg } from "./validate";

/** 对话另存 IPC（UI 重做第 4 层）：只读。id 可以是链上任意一段，转链根由 ConversationStore 负责。 */
export function convHandlers(d: { conv: Pick<ConversationStore, "list" | "search"> }): {
  list: (id: unknown, opts: unknown) => ConvPage;
  search: (id: unknown, query: unknown) => ConvMessage[];
} {
  return {
    list(id, opts) {
      const sid = sessionIdArg(id);
      const o = convListOptsArg(opts);
      return d.conv.list(sid, o);
    },
    search(id, query) {
      const sid = convRootArg(id);
      const q = convQueryArg(query);
      return d.conv.search(sid, q);
    },
  };
}
