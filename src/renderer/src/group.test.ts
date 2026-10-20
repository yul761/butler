import { describe, expect, it } from "vitest";
import type { TicketView } from "../../shared/types";
import { groupTickets } from "./group";

const t = (key: string, effectiveStatus: TicketView["effectiveStatus"], waiting = false): TicketView => ({
  key, title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b",
  status: effectiveStatus, statusManual: null, createdAt: 1, archivedAt: null, effectiveStatus, sessions: [], waiting,
});

describe("groupTickets", () => {
  it("orders groups by urgency, waiting tickets first, drops empty groups", () => {
    const groups = groupTickets([t("B-2", "active"), t("A-1", "active"), t("C-3", "active", true), t("D-4", "merged_pending_followup"), t("E-5", "done")]);
    expect(groups.map((g) => g.status)).toEqual(["merged_pending_followup", "active", "done"]);
    expect(groups[1].tickets.map((x) => x.key)).toEqual(["C-3", "A-1", "B-2"]);
  });
});
