import { describe, expect, it } from "vitest";
import { attachSince, attachSnapshot, type PtyAttachDeps } from "./pty-attach";

function deps(sinceResult: ReturnType<PtyAttachDeps["pty"]["since"]> = null) {
  const calls: string[] = [];
  const d: PtyAttachDeps = {
    pty: {
      snapshotAt: (id) => {
        calls.push(`snapshot ${id}`);
        return { data: "all", exitCode: null, mark: { epoch: 1, end: 3 } };
      },
      since: (id) => {
        calls.push(`since ${id}`);
        return sinceResult;
      },
    },
    ptySubs: { attach: (id) => void calls.push(`attach ${id}`) },
    ptyOutput: { flush: (id) => void calls.push(`flush ${id}`) },
  };
  return { d, calls };
}

describe("pty attach (BTL-277)", () => {
  it("sends the batched output before attaching and taking the snapshot", () => {
    const { d, calls } = deps();
    expect(attachSnapshot(d, "t1").data).toBe("all");
    expect(calls).toEqual(["flush t1", "attach t1", "snapshot t1"]);
  });

  it("does the same before the delta of a re-attach", () => {
    const { d, calls } = deps({ data: "new", exitCode: null, mark: { epoch: 1, end: 6 } });
    expect(attachSince(d, "t1", { epoch: 1, end: 3 })).toEqual({ reset: false, data: "new", exitCode: null, mark: { epoch: 1, end: 6 } });
    expect(calls).toEqual(["flush t1", "attach t1", "since t1"]);
  });

  it("falls back to a full snapshot (reset) when the delta is gone or the mark is bad", () => {
    const { d, calls } = deps(null);
    expect(attachSince(d, "t1", { epoch: 1, end: 3 })).toMatchObject({ reset: true, data: "all" });
    expect(attachSince(d, "t1", { nope: 1 })).toMatchObject({ reset: true, data: "all" });
    expect(calls).toEqual(["flush t1", "attach t1", "since t1", "snapshot t1", "flush t1", "attach t1", "snapshot t1"]);
  });
});
