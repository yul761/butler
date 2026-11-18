import { checkKeyArg, checkLessonIdArg, checkScopeArg, checksActionArg } from "./validate";
import { describe, expect, it } from "vitest";
import { TERMS_LIMIT } from "../settings/settings-values";
import type { LessonAction } from "../../shared/lessons";
import { batchIdArg, batchListArg, exportRequestArg, importApplyArg, importRetargetArg, lessonTargetArg, policyScopeArg, policySetArg, starterTargetArg } from "./validate";
import { availabilityActionArg, apiKeyArg, boolArg, auditCursorArg, addRepoArg, createEpicArg, createFeatureArg, createTicketArg, dirArg, epicIdArg, epicNameArg, featureIdArg, inboxAnswerArg, inboxIdArg, inboxScopeArg, lessonActionArg, progressFilterArg, lessonQueueIdArg, lessonRunIdArg, lessonSlugArg, moveTargetArg, prStagesScopeArg, prUrlArg, openButlerArg, openEpicArg, openFeatureArg, openFixArg, clipboardTextArg, factIdArg, repoIdArg, routingActionArg, sessionIdArg, switchModelArg, sessionIdsArg, termsArg, ticketKeyArg, TERMS_INPUT_LIMIT, updateRepoArg, updateTicketArg } from "./validate";

describe("IPC argument validation", () => {
  it("accepts only a string of bounded length as an API key", () => {
    expect(apiKeyArg("sk-0123456789")).toBe("sk-0123456789");
    for (const bad of [undefined, null, 42, ["sk-0123456789"], { key: "sk-0123456789" }, "x".repeat(5000)]) {
      expect(() => apiKeyArg(bad)).toThrow(expect.objectContaining({ code: "invalid_setting" }));
    }
  });

  it("does not echo the rejected key in the error", () => {
    try {
      apiKeyArg(`sk-${"y".repeat(5000)}`);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("yyyy");
    }
  });

  it("accepts a bounded array of terms and normalizes it", () => {
    expect(termsArg([{ term: "  Ｐｈｏｅｎｉｘ ", category: "term" }, { term: "phoenix", category: "term" }, { term: "Alice Wang", category: "person" }])).toEqual([
      { term: "Phoenix", category: "term" },
      { term: "Alice Wang", category: "person" },
    ]);
    expect(termsArg([])).toEqual([]);
  });

  it("rejects terms of the wrong shape, too many entries or oversized strings before normalizing", () => {
    const ok = { term: "Phoenix", category: "term" };
    for (const bad of [
      undefined, null, "Phoenix", { 0: ok, length: 1 },
      [null], ["Phoenix"], [{ term: 1, category: "term" }], [{ term: "Phoenix", category: "secret" }], [{ term: "Phoenix" }],
      Array.from({ length: TERMS_INPUT_LIMIT + 1 }, () => ok),
      [{ term: "x".repeat(10_000), category: "term" }],
    ]) {
      expect(() => termsArg(bad)).toThrow(expect.objectContaining({ code: "invalid_setting" }));
    }
    expect(TERMS_INPUT_LIMIT).toBeGreaterThanOrEqual(TERMS_LIMIT);
  });

  it("accepts no cursor or a positive integer audit cursor", () => {
    expect(auditCursorArg(undefined)).toBeUndefined();
    expect(auditCursorArg(null)).toBeUndefined();
    expect(auditCursorArg(1)).toBe(1);
    expect(auditCursorArg(12345)).toBe(12345);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, "12", [12], { id: 12 }, true]) {
      expect(() => auditCursorArg(bad)).toThrow();
    }
  });
});

describe("memory IPC arguments", () => {
  it("accepts a ticket key and a StateCore fact id, nothing else", () => {
    expect(ticketKeyArg("PROJ-12")).toBe("PROJ-12");
    expect(factIdArg("0e133fce-6f5f-40b6-9905-4119541d9a7e")).toBe("0e133fce-6f5f-40b6-9905-4119541d9a7e");
    for (const bad of [undefined, null, 1, "", "x".repeat(201), {}]) expect(() => ticketKeyArg(bad), String(bad)).toThrow();
    for (const bad of [undefined, "", "a b", "../x", "x".repeat(101), 5]) expect(() => factIdArg(bad), String(bad)).toThrow();
  });

  it("accepts only a boolean for on/off switches", () => {
    expect(boolArg(true)).toBe(true);
    expect(boolArg(false)).toBe(false);
    for (const bad of ["true", 1, null, undefined]) expect(() => boolArg(bad)).toThrow();
  });
});

describe("ticket edit and clipboard IPC arguments", () => {
  it("accepts a title update, a new repo and a repo update, and rejects anything else", () => {
    expect(updateTicketArg({ key: "P-1", title: "t", extra: 1 })).toEqual({ key: "P-1", title: "t" });
    for (const bad of [null, "P-1", { key: "" }, { key: "P-1" }, { key: "P-1", title: 3 }, { key: "P-1", title: "x".repeat(501) }]) {
      expect(() => updateTicketArg(bad)).toThrow();
    }
    expect(addRepoArg({ ticketKey: "P-1", repoPath: "/r", workMode: "branch" })).toEqual({ ticketKey: "P-1", repoPath: "/r", workMode: "branch", branch: undefined });
    for (const bad of [{ ticketKey: "P-1", repoPath: "", workMode: "branch" }, { ticketKey: "P-1", repoPath: "/r" }, { ticketKey: "P-1", repoPath: "/r", workMode: "x" }]) {
      expect(() => addRepoArg(bad)).toThrow();
    }
    expect(updateRepoArg({ repoId: 3, branch: "b" })).toEqual({ repoId: 3, branch: "b", workMode: undefined });
    for (const bad of [{ repoId: 0 }, { repoId: 1.5 }, { repoId: "1" }, { repoId: 1, workMode: "x" }, { repoId: 1, branch: "x".repeat(251) }]) {
      expect(() => updateRepoArg(bad)).toThrow();
    }
    expect(repoIdArg(7)).toBe(7);
    expect(() => repoIdArg(-1)).toThrow();
  });

  it("accepts only a bounded string for the clipboard", () => {
    expect(clipboardTextArg("hi")).toBe("hi");
    expect(() => clipboardTextArg(3)).toThrow();
    expect(() => clipboardTextArg("x".repeat(1024 * 1024 + 1))).toThrow();
  });
});

describe("session id argument", () => {
  it("accepts ids made of letters, digits and dashes only", () => {
    expect(sessionIdArg("1125e68e-5407-4868-9ca8-5a306155f393")).toBe("1125e68e-5407-4868-9ca8-5a306155f393");
    for (const bad of ["", "../x", "a b", 3, null, "x".repeat(101)]) expect(() => sessionIdArg(bad)).toThrow();
    expect(sessionIdsArg(["s1", "1125e68e-5407-4868-9ca8-5a306155f393"])).toEqual(["s1", "1125e68e-5407-4868-9ca8-5a306155f393"]);
    expect(sessionIdsArg([])).toEqual([]);
    for (const bad of ["s1", null, ["s1", "../x"], Array.from({ length: 501 }, (_, i) => `s${i}`)]) expect(() => sessionIdsArg(bad)).toThrow();
  });
});

describe("feature IPC arguments (design 2026-10-26)", () => {
  it("accepts a feature with a bounded name and 1–20 repo paths", () => {
    expect(createFeatureArg({ name: "结账改版", repoPaths: ["/c/shop/frontend"] })).toEqual({ name: "结账改版", repoPaths: ["/c/shop/frontend"], workspaceDir: undefined });
    expect(createFeatureArg({ name: "x", repoPaths: ["/a"], workspaceDir: "/w" }).workspaceDir).toBe("/w");
    for (const bad of [
      null, { name: "", repoPaths: ["/a"] }, { name: "x".repeat(101), repoPaths: ["/a"] }, { name: "x", repoPaths: [] },
      { name: "x", repoPaths: Array(21).fill("/a") }, { name: "x", repoPaths: [""] }, { name: "x", repoPaths: ["x".repeat(4097)] },
      { name: "x", repoPaths: "/a" }, { name: "x", repoPaths: ["/a"], workspaceDir: 5 },
    ]) {
      expect(() => createFeatureArg(bad), JSON.stringify(bad)?.slice(0, 80)).toThrow();
    }
  });

  it("accepts only positive integers as a feature id", () => {
    expect(featureIdArg(3)).toBe(3);
    for (const bad of [0, -1, 1.5, "3", null, undefined]) expect(() => featureIdArg(bad)).toThrow();
  });

  it("checks the feature id and repo paths a new ticket carries", () => {
    expect(createTicketArg({ key: "DMS-1", featureId: 2, repoPaths: ["/a", "/b"], workMode: "worktree" })).toMatchObject({ key: "DMS-1", featureId: 2, repoPaths: ["/a", "/b"] });
    expect(createTicketArg({ key: "DMS-1", title: "t", repoPath: "/a", workMode: "branch", branch: "b" })).toEqual({
      key: "DMS-1", title: "t", repoPath: "/a", workMode: "branch", branch: "b", repoPaths: undefined, featureId: undefined,
    });
    for (const bad of [{ key: "DMS-1", featureId: "2" }, { key: "DMS-1", repoPaths: [""] }, { key: "DMS-1", workMode: "copy" }, { key: "" }]) {
      expect(() => createTicketArg(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("checks the fix session request", () => {
    expect(openFixArg({ featureId: 1, stuckSessionId: "abc-1", extra: "x" })).toEqual({ featureId: 1, stuckSessionId: "abc-1" });
    for (const bad of [null, {}, { featureId: 1 }, { stuckSessionId: "abc-1" }, { featureId: 1, stuckSessionId: "../x" }, { featureId: 0, stuckSessionId: "a" }]) {
      expect(() => openFixArg(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("checks the feature session request and the directory to scan", () => {
    expect(openFeatureArg({ featureId: 1, sessionId: "abc-1", prefill: "hi" })).toEqual({ featureId: 1, sessionId: "abc-1", prefill: "hi" });
    expect(() => openFeatureArg({ featureId: 1, sessionId: "../x" })).toThrow();
    expect(dirArg("/c/shop")).toBe("/c/shop");
    for (const bad of ["", 5, "x".repeat(4097)]) expect(() => dirArg(bad)).toThrow();
  });
});

describe("epic IPC arguments (design 2026-11-01)", () => {
  it("accepts an epic with a bounded name and 1–20 repo paths", () => {
    expect(createEpicArg({ name: "结账改版", repoPaths: ["/c/shop/frontend"] })).toEqual({ name: "结账改版", repoPaths: ["/c/shop/frontend"], workspaceDir: undefined });
    expect(createEpicArg({ name: "x", repoPaths: ["/a"], workspaceDir: "/w", extra: 1 })).toEqual({ name: "x", repoPaths: ["/a"], workspaceDir: "/w" });
    for (const bad of [
      null, "x", { name: "", repoPaths: ["/a"] }, { name: "x".repeat(101), repoPaths: ["/a"] }, { name: 3, repoPaths: ["/a"] }, { name: "x" }, { name: "x", repoPaths: [] },
      { name: "x", repoPaths: Array(21).fill("/a") }, { name: "x", repoPaths: [""] }, { name: "x", repoPaths: "/a" }, { name: "x", repoPaths: ["/a"], workspaceDir: 5 },
    ]) {
      expect(() => createEpicArg(bad), JSON.stringify(bad)?.slice(0, 80)).toThrow();
    }
  });

  it("accepts only positive integers as an epic id", () => {
    expect(epicIdArg(3)).toBe(3);
    for (const bad of [0, -1, 1.5, "3", null, undefined]) expect(() => epicIdArg(bad)).toThrow();
  });

  it("reports a blank or overlong name as invalid_name, which the page words for an epic", () => {
    expect(epicNameArg("结账改版")).toBe("结账改版");
    for (const bad of ["", "   ", "x".repeat(101), 5, null]) {
      expect(() => epicNameArg(bad), String(bad).slice(0, 20)).toThrow(expect.objectContaining({ code: "invalid_name" }));
    }
  });

  it("checks the epic session request", () => {
    expect(openEpicArg({ epicId: 1, sessionId: "abc-1", prefill: "hi", extra: 1 })).toEqual({ epicId: 1, sessionId: "abc-1", prefill: "hi" });
    expect(openEpicArg({ epicId: 1 })).toEqual({ epicId: 1 });
    for (const bad of [null, {}, { epicId: 0 }, { epicId: 1, sessionId: "../x" }, { epicId: 1, prefill: 3 }, { epicId: 1, prefill: "x".repeat(100_001) }]) {
      expect(() => openEpicArg(bad), JSON.stringify(bad)?.slice(0, 80)).toThrow();
    }
  });

  it("checks the Butler 总控 session request (BTL-190 5)", () => {
    expect(openButlerArg({ sessionId: "abc-1", prefill: "hi", extra: 1 })).toEqual({ sessionId: "abc-1", prefill: "hi" });
    expect(openButlerArg({})).toEqual({});
    for (const bad of [null, 3, { sessionId: "../x" }, { prefill: 3 }, { prefill: "x".repeat(100_001) }]) {
      expect(() => openButlerArg(bad), JSON.stringify(bad)?.slice(0, 80)).toThrow();
    }
  });

  it("moves a feature into an epic or out with null, but a missing target is not a move out", () => {
    expect(moveTargetArg(4)).toBe(4);
    expect(moveTargetArg(null)).toBeNull();
    for (const bad of [undefined, 0, -1, 1.5, "4", ""]) expect(() => moveTargetArg(bad), String(bad)).toThrow();
  });
});

describe("inbox IPC arguments (BTL-190 2+3)", () => {
  it("accepts a positive item id, a non-blank bounded answer and one of three scopes", () => {
    expect(inboxIdArg(5)).toBe(5);
    for (const bad of [0, -1, 1.5, "5", null]) expect(() => inboxIdArg(bad)).toThrow();
    expect(inboxAnswerArg("用 A")).toBe("用 A");
    for (const bad of ["", "   ", 3, null, "x".repeat(4001)]) expect(() => inboxAnswerArg(bad)).toThrow();
    expect(inboxScopeArg({ featureId: 2 })).toEqual({ featureId: 2 });
    expect(inboxScopeArg({ epicId: 3 })).toEqual({ epicId: 3 });
    expect(inboxScopeArg({ all: true })).toEqual({ all: true });
    for (const bad of [null, {}, { all: 1 }, { featureId: 0 }, { epicId: "3" }, "all"]) expect(() => inboxScopeArg(bad), JSON.stringify(bad)).toThrow();
  });

  it("validates a PR stages scope", () => {
    expect(prStagesScopeArg({ ticketKey: "A-1" })).toEqual({ ticketKey: "A-1" });
    expect(prStagesScopeArg({ featureId: 1 })).toEqual({ featureId: 1 });
    expect(prStagesScopeArg({ epicId: 2 })).toEqual({ epicId: 2 });
    for (const bad of [{}, null, "A-1", { featureId: "x" }, { epicId: 0 }, { ticketKey: "" }]) expect(() => prStagesScopeArg(bad), JSON.stringify(bad)).toThrow();
  });

  it("validates a PR url to open: a string of at most 2000 chars", () => {
    expect(prUrlArg("https://github.com/a/b/pull/1")).toBe("https://github.com/a/b/pull/1");
    expect(prUrlArg("x".repeat(2000))).toHaveLength(2000);
    for (const bad of [null, 3, {}, ["https://github.com/a/b/pull/1"], "x".repeat(2001)]) expect(() => prUrlArg(bad), JSON.stringify(bad)).toThrow();
  });
});

describe("bulk lesson actions", () => {
  it("validate the verb, the target and the batch id", () => {
    expect(lessonActionArg({ op: "bulk", verb: "confirm", target: { filter: { slug: "acme/web", status: ["pending"] } } })).toEqual({
      op: "bulk", verb: "confirm", target: { filter: { slug: "acme/web", status: ["pending"] } },
    });
    expect(lessonActionArg({ op: "bulk", verb: "delete", target: { ids: [1, 2] } })).toEqual({ op: "bulk", verb: "delete", target: { ids: [1, 2] } });
    expect(lessonActionArg({ op: "enrich", extra: 1 })).toEqual({ op: "enrich" });
    expect(lessonActionArg({ op: "acceptRecommended" })).toEqual({ op: "acceptRecommended" });
    expect(lessonActionArg({ op: "bulk", verb: "confirm", target: { filter: { maxId: 40 } }, expect: 12 })).toEqual({ op: "bulk", verb: "confirm", target: { filter: { maxId: 40 } }, expect: 12 });
    expect(lessonActionArg({ op: "acceptRecommended", expect: 0 })).toEqual({ op: "acceptRecommended", expect: 0 });
    for (const bad of [-1, 1.5, "3", null]) expect(() => lessonActionArg({ op: "bulk", verb: "confirm", target: { ids: [1] }, expect: bad })).toThrow();
    expect(() => lessonActionArg({ op: "bulk", verb: "confirm", target: { filter: { maxId: -1 } } })).toThrow();
    expect(lessonActionArg({ op: "acceptRecommended", target: { filter: {} } })).toEqual({ op: "acceptRecommended", target: { filter: {} } });
    expect(lessonActionArg({ op: "undoBatch", batchId: 3 })).toEqual({ op: "undoBatch", batchId: 3 });
    for (const bad of [
      { op: "bulk", verb: "explode", target: { ids: [1] } },
      { op: "bulk", verb: "confirm" },
      { op: "bulk", verb: "confirm", target: { ids: [1], filter: {} } },
      { op: "bulk", verb: "confirm", target: { ids: [0] } },
      { op: "bulk", verb: "confirm", target: { ids: Array.from({ length: 5001 }, (_, i) => i + 1) } },
      { op: "bulk", verb: "confirm", target: { filter: { status: ["nope"] } } },
      { op: "bulk", verb: "confirm", target: { other: 1 } },
      { op: "undoBatch", batchId: 0 },
      { op: "undoBatch", batchId: "1" },
    ]) expect(() => lessonActionArg(bad), JSON.stringify(bad).slice(0, 80)).toThrow();
    expect(() => lessonTargetArg([])).toThrow();
    expect(batchIdArg(1)).toBe(1);
    expect(batchListArg(undefined)).toEqual({});
    expect(batchListArg({ limit: 50, beforeId: 9 })).toEqual({ limit: 50, beforeId: 9 });
    for (const bad of [{ limit: 0 }, { limit: 501 }, { beforeId: -1 }, { other: 1 }, []]) expect(() => batchListArg(bad)).toThrow();
  });
});

describe("lessonActionArg", () => {
  it("rejects blank text, unknown ops and bad fields", () => {
    expect(() => lessonActionArg({ op: "edit", id: 1, text: "  " })).toThrow();
    expect(() => lessonActionArg({ op: "nope" })).toThrow();
    expect(() => lessonActionArg({ op: "edit", id: 1, text: "x".repeat(2001) })).toThrow();
    expect(() => lessonActionArg({ op: "reject", id: "1" })).toThrow();
    expect(() => lessonActionArg({ op: "createProduct", name: " ", slugs: [] })).toThrow();
    expect(() => lessonActionArg({ op: "createProduct", name: "p", slugs: [1] })).toThrow();
    expect(() => lessonActionArg(null)).toThrow();
  });

  it("every op accepts a valid payload", () => {
    const valid: LessonAction[] = [
      { op: "confirm", id: 1 },
      { op: "confirm", id: 1, text: "t" },
      { op: "reject", id: 1 },
      { op: "edit", id: 1, text: "t" },
      { op: "setDisabled", id: 1, disabled: false },
      { op: "delete", id: 1 },
      { op: "merge", keepId: 1, dropId: 2, text: "t" },
      { op: "createProduct", name: "shop", slugs: ["a/b"] },
      { op: "deleteProduct", id: 1 },
      { op: "addToProduct", id: 1, slug: "a/b" },
      { op: "removeFromProduct", id: 1, slug: "a/b" },
      { op: "backfill", slug: "a/b" },
      { op: "openSource", sourceId: 1 },
      { op: "retry", queueId: 1 },
      { op: "retryFailed", slug: "a/b" },
      { op: "cancel", queueId: 2 },
      { op: "pauseQueue" },
      { op: "resumeQueue" },
      { op: "runNow" },
    ];
    for (const a of valid) expect(lessonActionArg(a), a.op).toEqual(a);
  });

  it("lessonActionArg accepts the queue ops and rejects a non-integer queueId", () => {
    expect(lessonActionArg({ op: "retry", queueId: 3 })).toEqual({ op: "retry", queueId: 3 });
    expect(lessonActionArg({ op: "pauseQueue", extra: 1 })).toEqual({ op: "pauseQueue" });
    for (const bad of [1.5, 0, -1, "1", null, undefined, NaN]) {
      expect(() => lessonActionArg({ op: "cancel", queueId: bad })).toThrow();
      expect(() => lessonActionArg({ op: "retry", queueId: bad })).toThrow();
    }
    expect(() => lessonActionArg({ op: "retryFailed" })).toThrow();
  });

  it("lessonActionArg accepts openInClaude with a positive runId", () => {
    expect(lessonActionArg({ op: "openInClaude", runId: 3 })).toEqual({ op: "openInClaude", runId: 3 });
    for (const bad of [0, -1, 1.5, "3", undefined]) expect(() => lessonActionArg({ op: "openInClaude", runId: bad })).toThrow();
  });

  it("lessonRunIdArg rejects 0 and strings", () => {
    expect(lessonRunIdArg(7)).toBe(7);
    for (const bad of [0, -1, 1.5, "1", null, undefined]) expect(() => lessonRunIdArg(bad)).toThrow();
    expect(() => lessonRunIdArg(0)).toThrow("invalid lesson run id");
    expect(() => lessonQueueIdArg(0)).toThrow("invalid lesson queue id");
    expect(lessonQueueIdArg(3)).toBe(3);
    expect(() => lessonActionArg({ op: "cancel", queueId: 0 })).toThrow("invalid lesson queue id");
    expect(lessonSlugArg("a/b")).toBe("a/b");
    expect(() => lessonSlugArg("")).toThrow();
  });

  it("returns valid actions, trimming text and names", () => {
    expect(lessonActionArg({ op: "backfill", slug: "acme/web" })).toEqual({ op: "backfill", slug: "acme/web" });
    expect(lessonActionArg({ op: "confirm", id: 2 })).toEqual({ op: "confirm", id: 2 });
    expect(lessonActionArg({ op: "confirm", id: 2, text: " hi " })).toEqual({ op: "confirm", id: 2, text: "hi" });
    expect(lessonActionArg({ op: "createProduct", name: " shop ", slugs: ["a/b"] })).toEqual({ op: "createProduct", name: "shop", slugs: ["a/b"] });
    expect(lessonActionArg({ op: "merge", keepId: 1, dropId: 2, text: "t" })).toEqual({ op: "merge", keepId: 1, dropId: 2, text: "t" });
    expect(lessonActionArg({ op: "setDisabled", id: 1, disabled: true })).toEqual({ op: "setDisabled", id: 1, disabled: true });
  });

  it("availabilityActionArg accepts the two ops and rejects others", () => {
    expect(availabilityActionArg({ op: "resumeLessons" })).toEqual({ op: "resumeLessons" });
    expect(availabilityActionArg({ op: "pauseLessons", extra: 1 })).toEqual({ op: "pauseLessons" });
    for (const bad of [null, undefined, "pauseLessons", {}, { op: "x" }, { op: 1 }]) expect(() => availabilityActionArg(bad)).toThrow();
  });
});

describe("policy and config import / export arguments", () => {
  const tok = "0123abcd-0123-4567-89ab-0123456789ab";
  it("accepts the three policy layers and checks override values", () => {
    expect(policyScopeArg({ kind: "global" })).toEqual({ kind: "global" });
    expect(policyScopeArg({ kind: "product", productId: 2 })).toEqual({ kind: "product", productId: 2 });
    expect(policyScopeArg({ kind: "repo", slug: "o/web" })).toEqual({ kind: "repo", slug: "o/web" });
    for (const bad of [null, {}, { kind: "global", slug: "x" }, { kind: "product", productId: 0 }, { kind: "repo" }, { kind: "x" }]) expect(() => policyScopeArg(bad)).toThrow();
    expect(policySetArg({ scope: { kind: "global" }, overrides: { "score.admitLine": 0.8 } })).toEqual({ scope: { kind: "global" }, overrides: { "score.admitLine": 0.8 } });
    expect(() => policySetArg({ scope: { kind: "global" }, overrides: { "score.admitLine": 2 } })).toThrow();
    expect(() => policySetArg({ scope: { kind: "global" }, overrides: { nope: 1 } })).toThrow();
  });

  it("checks export requests", () => {
    const options = { content: "all", includeSourceUrls: false };
    expect(exportRequestArg({ scope: { kind: "all" }, options })).toEqual({ scope: { kind: "all" }, options });
    expect(exportRequestArg({ scope: { kind: "repo", slug: "o/web" }, options, starter: { name: " pack " } }).starter).toEqual({ name: "pack" });
    for (const bad of [
      { scope: { kind: "all" }, options: { content: "x", includeSourceUrls: false } },
      { scope: { kind: "all" }, options: { content: "all" } },
      { scope: { kind: "product" }, options },
      { scope: { kind: "all" }, options, starter: { name: "" } },
      { scope: { kind: "all" }, options, extra: 1 },
    ]) expect(() => exportRequestArg(bad)).toThrow();
  });

  it("checks import apply and retarget requests", () => {
    const fp = "0123456789abcdef";
    expect(importApplyArg({ token: tok, mode: "merge" })).toEqual({ token: tok, mode: "merge" });
    expect(importApplyArg({ token: tok, mode: "replace", bulk: "local", resolutions: { [`lessons:${fp}`]: "imported" } })).toEqual({
      token: tok, mode: "replace", bulk: "local", resolutions: { [`lessons:${fp}`]: "imported" },
    });
    for (const bad of [
      { token: "x", mode: "merge" },
      { token: tok, mode: "both" },
      { token: tok, mode: "merge", bulk: "mine" },
      { token: tok, mode: "merge", resolutions: { "lessons:zz": "imported" } },
      { token: tok, mode: "merge", resolutions: { [`lessons:${fp}`]: "maybe" } },
      { token: tok, mode: "merge", resolutions: [] },
    ]) expect(() => importApplyArg(bad)).toThrow();
    expect(importRetargetArg({ token: tok, target: { kind: "repo", slug: "o/web" } })).toEqual({ token: tok, target: { kind: "repo", slug: "o/web" } });
    expect(starterTargetArg({ kind: "product", productId: 4 })).toEqual({ kind: "product", productId: 4 });
    expect(() => starterTargetArg({ kind: "all" })).toThrow();
  });
});

describe("checks IPC arguments", () => {
  it("accepts well-formed actions and rejects the rest", () => {
    expect(checkScopeArg({ kind: "repo", slug: "acme/web" })).toEqual({ kind: "repo", slug: "acme/web" });
    expect(() => checkScopeArg({ kind: "repo", slug: "nope" })).toThrow();
    // 别的主机带主机名和子组；一律小写。
    expect(checkScopeArg({ kind: "repo", slug: "gitlab.com/Grp/Sub/Repo" })).toEqual({ kind: "repo", slug: "gitlab.com/grp/sub/repo" });
    expect(checkScopeArg({ kind: "repo", slug: " Acme/Web " })).toEqual({ kind: "repo", slug: "acme/web" });
    expect(() => checkScopeArg({ kind: "repo", slug: "a//b" })).toThrow();
    expect(checkKeyArg("builtin:comment_policy")).toBe("builtin:comment_policy");
    expect(() => checkKeyArg("a b")).toThrow();
    expect(checksActionArg({ op: "save", scope: { kind: "global" }, id: null, input: { type: "forbidden_pattern" } })).toMatchObject({ op: "save", id: null, lessonId: null });
    expect(() => checksActionArg({ op: "save", scope: { kind: "global" }, id: null, input: "x".repeat(70_000) })).toThrow();
    expect(checksActionArg({ op: "bulk", ids: [1, 2], verb: "shadow" })).toEqual({ op: "bulk", ids: [1, 2], verb: "shadow" });
    expect(() => checksActionArg({ op: "bulk", ids: [], verb: "shadow" })).toThrow();
    expect(() => checksActionArg({ op: "bulk", ids: [1], verb: "explode" })).toThrow();
    expect(checksActionArg({ op: "verdict", hitId: 3, verdict: null })).toEqual({ op: "verdict", hitId: 3, verdict: null });
    expect(() => checksActionArg({ op: "verdict", hitId: 3, verdict: "maybe" })).toThrow();
    expect(checksActionArg({ op: "classify", lessonId: 4, checkability: "prose" })).toEqual({ op: "classify", lessonId: 4, checkability: "prose" });
    expect(() => checksActionArg({ op: "classify", lessonId: 4, checkability: "converted" })).toThrow();
    expect(() => checksActionArg({ op: "nope" })).toThrow();
    expect(() => checkLessonIdArg(0)).toThrow();
  });
});

describe("routingActionArg", () => {
  it("accepts well-formed actions and rejects the rest", () => {
    expect(routingActionArg({ op: "discover" })).toEqual({ op: "discover" });
    const model = { name: "corp-x", tier: "mid", enabled: true, account: "default", priceIn: 3, priceOut: null, note: "" };
    expect(routingActionArg({ op: "addModel", model })).toEqual({ op: "addModel", model });
    expect(routingActionArg({ op: "updateModel", name: "corp-x", patch: { enabled: false } })).toEqual({ op: "updateModel", name: "corp-x", patch: { enabled: false } });
    expect(routingActionArg({ op: "setTaskRoute", route: { task: "pr_brief", tier: "low" } })).toEqual({
      op: "setTaskRoute", route: { task: "pr_brief", tier: "low", minTier: null, policy: null, critical: null },
    });
    expect(routingActionArg({ op: "confirmError", id: 3, category: "usage_limit", accountLevel: true })).toMatchObject({ id: 3 });
    for (const bad of [
      null, { op: "nope" }, { op: "addModel", model: { ...model, priceIn: -1 } }, { op: "addModel", model: { ...model, tier: "ultra" } },
      { op: "setChain", tier: "mid", models: [1] }, { op: "setTaskRoute", route: { task: "bogus" } }, { op: "confirmError", id: 1.5, category: "usage_limit", accountLevel: true },
      { op: "moveModel", name: "x", delta: 2 }, { op: "addRule", rule: { kind: "eval", pattern: "x", category: null, accountLevel: false, note: "" } },
    ]) {
      expect(() => routingActionArg(bad)).toThrow();
    }
    expect(switchModelArg(undefined)).toBeUndefined();
    expect(switchModelArg("corp-x")).toBe("corp-x");
    expect(() => switchModelArg("bad name!")).toThrow();
  });
});

describe("progressFilterArg", () => {
  it("accepts no filter, either id or both, and rejects anything else", () => {
    expect(progressFilterArg(undefined)).toEqual({ epicId: null, featureId: null });
    expect(progressFilterArg({ epicId: 3 })).toEqual({ epicId: 3, featureId: null });
    expect(progressFilterArg({ epicId: null, featureId: 7 })).toEqual({ epicId: null, featureId: 7 });
    for (const bad of ["x", [1], { epicId: 0 }, { featureId: 1.5 }, { featureId: "2" }]) expect(() => progressFilterArg(bad)).toThrow();
  });
});
