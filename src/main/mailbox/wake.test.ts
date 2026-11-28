import { describe, expect, it } from "vitest";
import { hasSessionMail, headsWithWakingMail, type QueuedMail } from "./wake";

// rebase 段复核建议 1：哪些排着的消息叫醒、恢复一个 session。index.ts 里的两处判断抽到这里（接线见 index-mailbox-wiring.test.ts）。
const same = (id: string): string => id;
const fact = (wake: boolean, from: string | null = "s-ctrl", to = "s1"): QueuedMail => ({ kind: "fact", fromSession: from, toSession: to, meta: { wake } });
const notice = (to = "s1"): QueuedMail => ({ kind: "answer", fromSession: null, toSession: to });
const msg = (to = "s1", from: string | null = "s-ctrl"): QueuedMail => ({ kind: "message", fromSession: from, toSession: to });
const convention = (to = "s1"): QueuedMail => ({ kind: "convention", fromSession: "s-ctrl", toSession: to });

describe("hasSessionMail (a closed session is restored in the background)", () => {
  it("a closed session with a queued unimportant fact plus a Shipherd notice (CI etc.) is not restored", () => {
    expect(hasSessionMail([fact(false), notice()], same, "s1")).toBe(false);
  });

  it("an unimportant fact from another session does not restore it (only meta.wake facts do)", () => {
    expect(hasSessionMail([fact(false)], same, "s1")).toBe(false);
    expect(hasSessionMail([{ kind: "fact", fromSession: "s-ctrl", toSession: "s1" }], same, "s1")).toBe(false);
    expect(hasSessionMail([fact(true)], same, "s1")).toBe(true);
  });

  it("a Shipherd notice alone (fromSession null) does not restore it, even a kind that would wake", () => {
    expect(hasSessionMail([notice()], same, "s1")).toBe(false);
    expect(hasSessionMail([msg("s1", null)], same, "s1")).toBe(false);
    expect(hasSessionMail([fact(true, null)], same, "s1")).toBe(false);
  });

  it("a message from another session restores it; a convention does not", () => {
    expect(hasSessionMail([msg()], same, "s1")).toBe(true);
    expect(hasSessionMail([convention()], same, "s1")).toBe(false);
  });

  it("matches by the recipient's current head, not by another head's mail", () => {
    const headOf = (id: string): string => (id === "s-old" ? "s1" : id);
    expect(hasSessionMail([msg("s-old")], headOf, "s1")).toBe(true);
    expect(hasSessionMail([msg("s-old")], same, "s1")).toBe(false);
    expect(hasSessionMail([msg("s2")], same, "s1")).toBe(false);
  });
});

describe("headsWithWakingMail (restored first after a restart)", () => {
  it("only messages that wake their target put a head first: conventions and unimportant facts do not", () => {
    const heads = headsWithWakingMail([convention("a"), fact(false, "s-ctrl", "b"), fact(true, "s-ctrl", "c"), msg("d"), notice("e")], same);
    expect([...heads].sort()).toEqual(["c", "d", "e"]);
  });

  it("maps each recipient to its current head", () => {
    const headOf = (id: string): string => (id === "s-old" ? "s-new" : id);
    expect([...headsWithWakingMail([msg("s-old")], headOf)]).toEqual(["s-new"]);
  });
});
