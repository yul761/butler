import { describe, expect, it, vi } from "vitest";
import type { Turn, TurnItem } from "../../shared/turn";
import { ciReasonText } from "./availability-view";
import { STRINGS } from "./strings";
import { runCardAction, type CardDeps } from "./turn-card-actions";

const S = STRINGS.zh;
const pr = { repo: "acme/app", number: 12, title: "Fix", url: "https://gh.example/acme/app/pull/12" };
const item = (turn: Turn, o: Partial<TurnItem> = {}): TurnItem =>
  ({ ticketKey: "BTL-1", pr: null, epicId: null, featureId: null, turn, since: 1000, others: 0, ...o });
const answer: Turn = { owner: "you", kind: "answer", question: "q?", options: ["可以", "不行"], askId: 7, sessionId: "s1" };
const stuck: Turn = { owner: "you", kind: "stuck", source: "silent", detail: null, sessionId: "s1" };
const unattended: Turn = { owner: "you", kind: "unattended", why: "ci_failing", canSend: true, sessionId: "s1" };
const review: Turn = { owner: "you", kind: "review", author: "bob", title: "Fix", url: "https://gh.example/acme/app/pull/40" };

function deps(o: Partial<CardDeps> = {}): CardDeps & { [K in keyof CardDeps]: ReturnType<typeof vi.fn> } {
  return {
    answerInbox: vi.fn(async () => true),
    prOpen: vi.fn(async () => ({ ok: true as const })),
    turnSendToAgent: vi.fn(async () => ({ ok: true })),
    onOpen: vi.fn(),
    onGo: vi.fn(),
    onFix: vi.fn(),
    onChanged: vi.fn(),
    ...o,
  } as never;
}

describe("runCardAction", () => {
  it("answer: delivered → answered with that option, no refetch", async () => {
    const d = deps();
    expect(await runCardAction({ id: "answer", option: "可以", primary: true }, item(answer), d, S)).toEqual({ answered: "可以" });
    expect(d.answerInbox).toHaveBeenCalledWith(7, "可以");
    expect(d.onChanged).not.toHaveBeenCalled();
  });

  it("answer: the ask is gone → answerGone and the board is refetched", async () => {
    const d = deps({ answerInbox: vi.fn(async () => false) });
    expect(await runCardAction({ id: "answer", option: "不行", primary: false }, item(answer), d, S)).toEqual({ message: S.hm.act.answerGone });
    expect(d.onChanged).toHaveBeenCalledTimes(1);
  });

  it("answer without an askId calls nothing", async () => {
    const d = deps();
    expect(await runCardAction({ id: "answer", option: "可以", primary: true }, item({ ...answer, askId: null }), d, S)).toBeNull();
    expect(d.answerInbox).not.toHaveBeenCalled();
  });

  it("send: passes only ticketKey and {repo, number}; ok refetches", async () => {
    const d = deps();
    expect(await runCardAction({ id: "send", primary: true }, item(unattended, { pr }), d, S)).toBeNull();
    expect(d.turnSendToAgent).toHaveBeenCalledWith({ ticketKey: "BTL-1", pr: { repo: "acme/app", number: 12 } });
    expect(d.onChanged).toHaveBeenCalledTimes(1);
  });

  it("send: failure reasons map to their own text, CI skips to the CI wording", async () => {
    const fail = (reason: string) => deps({ turnSendToAgent: vi.fn(async () => ({ ok: false, reason })) as never });
    const d1 = fail("not_found");
    expect(await runCardAction({ id: "send", primary: true }, item(unattended, { pr }), d1, S)).toEqual({ message: S.hm.act.sendNot(S.hm.act.sendReason.not_found) });
    expect(d1.onChanged).not.toHaveBeenCalled();
    expect(await runCardAction({ id: "send", primary: true }, item(unattended, { pr }), fail("delivered"), S))
      .toEqual({ message: S.hm.act.sendNot(ciReasonText("delivered", S)) });
    expect(await runCardAction({ id: "send", primary: true }, item(unattended, { pr }), deps({ turnSendToAgent: vi.fn(async () => ({ ok: false })) }), S))
      .toEqual({ message: S.hm.act.sendNot("") });
  });

  it("openPr: review opens its own url; bad_url says so", async () => {
    const d = deps();
    expect(await runCardAction({ id: "openPr", primary: true }, item(review, { ticketKey: null }), d, S)).toBeNull();
    expect(d.prOpen).toHaveBeenCalledWith("https://gh.example/acme/app/pull/40");
    const bad = deps({ prOpen: vi.fn(async () => ({ ok: false as const, reason: "bad_url" as const })) });
    expect(await runCardAction({ id: "openPr", primary: true }, item(review), bad, S)).toEqual({ message: S.hm.act.prOpenNot });
  });

  it("fix: opens on the stuck ticket's feature and session; not for a coordinator (no ticket)", async () => {
    const d = deps();
    await runCardAction({ id: "fix", primary: false }, item(stuck, { featureId: 3 }), d, S);
    expect(d.onFix).toHaveBeenCalledWith(3, "s1");
    const c = deps();
    await runCardAction({ id: "fix", primary: false }, item(stuck, { featureId: 3, ticketKey: null }), c, S);
    expect(c.onFix).not.toHaveBeenCalled();
  });

  it("look: a ticket card goes to the ticket page and lands by whose turn it is", async () => {
    const d = deps();
    await runCardAction({ id: "look", primary: true }, item(stuck), d, S);
    expect(d.onGo).toHaveBeenCalledWith({ page: "ticket", key: "BTL-1", landing: true });
    expect(d.onOpen).not.toHaveBeenCalled();
  });
});
