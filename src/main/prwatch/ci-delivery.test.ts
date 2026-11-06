import { describe, expect, it, vi } from "vitest";
import type { DeliveryGuard } from "../sessions/delivery-guard";
import type { PrWatchRow } from "../db/pr-watch-repo";
import { CiDelivery, deliveryKey } from "./ci-delivery";

const row = (o: Partial<PrWatchRow> = {}): PrWatchRow => ({
  ticketKey: "BTL-1", repoId: 1, repoPath: "/r", branch: "b", number: 7, url: "u", state: "open", review: "pending",
  ci: "failing", headSha: "abcdef1234567", checkedAt: 1, failed: [], deliveredKey: null, ...o,
});

function setup(opts: { session?: string | null; guard?: ReturnType<DeliveryGuard["check"]>; deliver?: () => Promise<"sent" | "exited" | "timeout"> } = {}) {
  const rows = new Map<number, PrWatchRow>();
  const repo = {
    all: () => [...rows.values()],
    get: (id: number) => rows.get(id) ?? null,
    setDelivered: (id: number, key: string) => { const r = rows.get(id); if (r) r.deliveredKey = key; },
  };
  const state = { guard: opts.guard ?? ({ ok: true, termId: "t1", headId: "h1" } as ReturnType<DeliveryGuard["check"]>), session: opts.session === undefined ? "h1" : opts.session };
  const deliver = vi.fn(opts.deliver ?? (async () => "sent" as const));
  const d = new CiDelivery({
    repo: repo as never, guard: { check: () => state.guard }, sessionFor: () => state.session, deliver, now: () => 1, log: () => {},
  });
  return { rows, state, deliver, d };
}

describe("CiDelivery", () => {
  it("delivers a failure with the failed checks and log tails", async () => {
    const { rows, deliver, d } = setup();
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const r = row({ failed: [{ name: "test", state: "failing", runId: 1, log: lines }, { name: "lint", state: "failing", runId: 1 }] });
    rows.set(1, r);
    await d.settled(r);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [term, text] = deliver.mock.calls[0] as unknown as [string, string];
    expect(term).toBe("t1");
    expect(text).toContain("PR #7");
    expect(text).toContain("abcdef1");
    expect(text).not.toContain("abcdef12");
    expect(text).toMatch(/test(、|, )lint/);
    expect(text).toContain("line99");
    expect(text).toContain("line40");
    expect(text).not.toContain("line39\n");
    expect(rows.get(1)!.deliveredKey).toBe("abcdef1234567:failing");
  });

  it("delivers a pass with the branch when there is no PR", async () => {
    const { rows, deliver, d } = setup();
    const r = row({ ci: "passing", number: null });
    rows.set(1, r);
    await d.settled(r);
    expect((deliver.mock.calls[0] as unknown as [string, string])[1]).toContain("b");
    expect(rows.get(1)!.deliveredKey).toBe(deliveryKey(r));
  });

  it("a log containing a fence cannot break out", async () => {
    const { rows, deliver, d } = setup();
    const r = row({ failed: [{ name: "t", state: "failing", runId: 1, log: "a\n```\nb" }] });
    rows.set(1, r);
    await d.settled(r);
    expect((deliver.mock.calls[0] as unknown as [string, string])[1]).toContain("````\na\n```\nb\n````");
  });

  it("queues until the session stops", async () => {
    const { rows, state, deliver, d } = setup({ guard: { ok: false, block: "busy" } });
    const r = row();
    rows.set(1, r);
    await d.settled(r);
    expect(deliver).not.toHaveBeenCalled();
    expect(rows.get(1)!.deliveredKey).toBeNull();
    state.guard = { ok: true, termId: "t1", headId: "h1" };
    await d.flush();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("does not deliver twice for the same key", async () => {
    const { rows, deliver, d } = setup();
    const r = row();
    rows.set(1, r);
    await d.settled(r);
    await d.settled({ ...r });
    await d.flush();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("does not mark when deliver fails", async () => {
    const { rows, deliver, d } = setup({ deliver: async () => "timeout" });
    const r = row();
    rows.set(1, r);
    await d.settled(r);
    expect(rows.get(1)!.deliveredKey).toBeNull();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the repo has no open session", async () => {
    const { rows, deliver, d } = setup({ session: null });
    const r = row();
    rows.set(1, r);
    await d.settled(r);
    await d.flush();
    expect(deliver).not.toHaveBeenCalled();
    expect(rows.get(1)!.deliveredKey).toBeNull();
  });

  it("skips pending rows in flush and sends one at a time per session", async () => {
    let release!: () => void;
    const { rows, deliver, d } = setup({ deliver: () => new Promise((res) => { release = () => res("sent"); }) });
    const r = row();
    rows.set(1, r);
    rows.set(2, row({ repoId: 2, ci: "pending" }));
    const p1 = d.settled(r);
    const p2 = d.flush();
    await Promise.resolve();
    release();
    await Promise.all([p1, p2]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
