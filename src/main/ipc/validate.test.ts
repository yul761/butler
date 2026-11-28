import { turnFilterArg, turnSendArg } from "./validate";
import { backtestActionArg, baselinesActionArg, checkExportActionArg, checkKeyArg, checkLessonIdArg, checkScopeArg, checksActionArg, legacyActionArg, legacyViolationsArg } from "./validate";
import { describe, expect, it } from "vitest";
import type { LessonAction } from "../../shared/lessons";
import { backgroundActionArg, costSetArg, costSubjectArg } from "./validate";
import { convListOptsArg, convQueryArg, convRootArg } from "./validate";
import { devMessageArg, forkIdArg, forkQuestionArg, messageIdArg, reportsPageArg } from "./validate";
import { TASK_LIMIT } from "../../shared/control";
import { FORK_QUESTION_MAX } from "../../shared/fork";
import { CONV_LIST_MAX, CONV_QUERY_MAX } from "../../shared/conversation";
import { commentActionArg, flakyActionArg, loopSetArg } from "./validate";
import { batchIdArg, batchListArg, exportRequestArg, importApplyArg, importRetargetArg, lessonTargetArg, policyScopeArg, policySetArg, starterTargetArg } from "./validate";
import { availabilityActionArg, boolArg, addRepoArg, CLOSE_RETRY_MAX, closeRetryArg, closeTicketArg, createFeatureArg, createTicketArg, dirArg, featureIdArg, inboxAnswerArg, inboxBehalfArg, inboxIdArg, inboxScopeArg, messageScopeArg, lessonActionArg, lessonQueueIdArg, lessonRunIdArg, lessonSlugArg, prStagesScopeArg, prUrlArg, linkUrlArg, openShipherdArg, openFeatureArg, openFixArg, clipboardTextArg, factIdArg, repoIdArg, routingActionArg, sessionIdArg, switchModelArg, sessionIdsArg, ticketKeyArg, updateRepoArg, updateTicketArg, versionArg } from "./validate";
import { flowActArg, flowIdArg, flowScopeArg } from "./validate";
import { EXTERNAL_LINK_MAX } from "../util/external-link";

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

describe("update IPC arguments (BTL-253)", () => {
  it("accepts a version number and nothing else", () => {
    expect(versionArg("4.1.0")).toBe("4.1.0");
    expect(versionArg(" v4.1.0-rc.1 ")).toBe("v4.1.0-rc.1");
    for (const bad of [undefined, 4, "", "latest", "4.1", "4.1.0 && rm", "4.1.0-" + "x".repeat(70)]) expect(() => versionArg(bad), String(bad)).toThrow();
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

describe("session request IPC arguments", () => {
  it("checks the Shipherd 总控 session request (BTL-190 5)", () => {
    expect(openShipherdArg({ sessionId: "abc-1", prefill: "hi", extra: 1 })).toEqual({ sessionId: "abc-1", prefill: "hi" });
    expect(openShipherdArg({})).toEqual({});
    for (const bad of [null, 3, { sessionId: "../x" }, { prefill: 3 }, { prefill: "x".repeat(100_001) }]) {
      expect(() => openShipherdArg(bad), JSON.stringify(bad)?.slice(0, 80)).toThrow();
    }
  });

});

describe("inbox IPC arguments (BTL-190 2+3)", () => {
  it("accepts a positive item id, a non-blank bounded answer and one of three scopes", () => {
    expect(inboxIdArg(5)).toBe(5);
    for (const bad of [0, -1, 1.5, "5", null]) expect(() => inboxIdArg(bad)).toThrow();
    expect(inboxAnswerArg("用 A")).toBe("用 A");
    for (const bad of ["", "   ", 3, null, "x".repeat(4001)]) expect(() => inboxAnswerArg(bad)).toThrow();
    // 「总控已代答」的改答案（BTL-269 A2）：超长直接拒绝，不截。
    expect(inboxBehalfArg({ op: "correct", id: 3, text: "B" })).toEqual({ op: "correct", id: 3, text: "B" });
    expect(inboxBehalfArg({ op: "correct", id: 3, text: "x".repeat(4000) })).toEqual({ op: "correct", id: 3, text: "x".repeat(4000) });
    expect(inboxBehalfArg({ op: "dismiss", id: 3 })).toEqual({ op: "dismiss", id: 3 });
    for (const bad of [null, {}, { op: "correct", id: 3, text: "x".repeat(4001) }, { op: "correct", id: 3, text: " " }, { op: "dismiss", id: 0 }, { op: "drop", id: 3 }]) {
      expect(() => inboxBehalfArg(bad), JSON.stringify(bad).slice(0, 60)).toThrow();
    }
    expect(inboxScopeArg({ featureId: 2 })).toEqual({ featureId: 2 });
    expect(messageScopeArg({ shipherd: true })).toEqual({ shipherd: true });
    expect(messageScopeArg({ featureId: 4 })).toEqual({ featureId: 4 });
    for (const bad of [null, {}, { shipherd: 1 }, { featureId: -1 }, { epicId: 1 }]) expect(() => messageScopeArg(bad)).toThrow();
    expect(inboxScopeArg({ all: true })).toEqual({ all: true });
    for (const bad of [null, {}, { all: 1 }, { featureId: 0 }, { epicId: 3 }, "all"]) expect(() => inboxScopeArg(bad), JSON.stringify(bad)).toThrow();
  });

  it("validates a PR stages scope", () => {
    expect(prStagesScopeArg({ ticketKey: "A-1" })).toEqual({ ticketKey: "A-1" });
    expect(prStagesScopeArg({ featureId: 1 })).toEqual({ featureId: 1 });
    for (const bad of [{}, null, "A-1", { featureId: "x" }, { epicId: 2 }, { ticketKey: "" }]) expect(() => prStagesScopeArg(bad), JSON.stringify(bad)).toThrow();
  });

  it("validates a PR url to open: a string of at most 2000 chars", () => {
    expect(prUrlArg("https://github.com/a/b/pull/1")).toBe("https://github.com/a/b/pull/1");
    expect(prUrlArg("x".repeat(2000))).toHaveLength(2000);
    for (const bad of [null, 3, {}, ["https://github.com/a/b/pull/1"], "x".repeat(2001)]) expect(() => prUrlArg(bad), JSON.stringify(bad)).toThrow();
  });

  it("validates a terminal link to open: a non-empty string up to EXTERNAL_LINK_MAX chars, rejected (not truncated) when longer", () => {
    expect(linkUrlArg("https://example.com/x")).toBe("https://example.com/x");
    // scheme 由 openExternalLink 检查，这里只管类型和长度。
    expect(linkUrlArg("file:///etc/passwd")).toBe("file:///etc/passwd");
    expect(linkUrlArg("x".repeat(EXTERNAL_LINK_MAX))).toHaveLength(EXTERNAL_LINK_MAX);
    for (const bad of [null, undefined, 3, {}, ["https://example.com"], "", "x".repeat(EXTERNAL_LINK_MAX + 1)]) expect(() => linkUrlArg(bad), JSON.stringify(bad)).toThrow();
  });
});

describe("merge proposal actions (BTL-274)", () => {
  it("validate the proposal id and the optional slug", () => {
    expect(lessonActionArg({ op: "acceptMerge", id: 3 })).toEqual({ op: "acceptMerge", id: 3 });
    expect(lessonActionArg({ op: "dismissMerge", id: 3 })).toEqual({ op: "dismissMerge", id: 3 });
    expect(lessonActionArg({ op: "suggestMerges" })).toEqual({ op: "suggestMerges" });
    expect(lessonActionArg({ op: "suggestMerges", slug: "acme/web" })).toEqual({ op: "suggestMerges", slug: "acme/web" });
    for (const bad of [{ op: "acceptMerge", id: "3" }, { op: "dismissMerge" }, { op: "suggestMerges", slug: 5 }]) expect(() => lessonActionArg(bad)).toThrow();
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
  });

  it("accepts only known backtest actions with positive ids", () => {
    expect(backtestActionArg({ op: "rerun", checkId: 3 })).toEqual({ op: "rerun", checkId: 3 });
    expect(backtestActionArg({ op: "clearReview", checkId: 3, extra: 1 })).toEqual({ op: "clearReview", checkId: 3 });
    expect(backtestActionArg({ op: "undo", batchId: 9 })).toEqual({ op: "undo", batchId: 9 });
    expect(backtestActionArg({ op: "dismissNotice", eventId: 2 })).toEqual({ op: "dismissNotice", eventId: 2 });
    expect(backtestActionArg({ op: "applyThreshold", id: 1 })).toEqual({ op: "applyThreshold", id: 1 });
    expect(backtestActionArg({ op: "dismissThreshold", id: 1 })).toEqual({ op: "dismissThreshold", id: 1 });
    expect(() => backtestActionArg({ op: "rerun", checkId: -1 })).toThrow();
    expect(() => backtestActionArg({ op: "undo", batchId: "1" })).toThrow();
    expect(() => backtestActionArg({ op: "drop" })).toThrow();
    expect(() => backtestActionArg(null)).toThrow();
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

describe("repo baseline arguments (E2)", () => {
  it("accepts the page's actions and rejects anything else", () => {
    expect(baselinesActionArg({ kind: "scan", slugs: ["a/b"], infer: true })).toEqual({ kind: "scan", slugs: ["a/b"], infer: true });
    expect(baselinesActionArg({ kind: "scan", slugs: ["a/b"], infer: false, force: false })).toEqual({ kind: "scan", slugs: ["a/b"], infer: false, force: false });
    expect(() => baselinesActionArg({ kind: "scan", slugs: ["../x"], infer: true })).toThrow();
    expect(() => baselinesActionArg({ kind: "scan", slugs: [], infer: true })).toThrow();
    expect(baselinesActionArg({ kind: "adopt", slug: "a/b", ids: ["|test|vitest"], confirmLow: [] })).toMatchObject({ kind: "adopt" });
    expect(() => baselinesActionArg({ kind: "adopt", slug: "a/b", ids: "x", confirmLow: [] })).toThrow();
    expect(baselinesActionArg({ kind: "ruleSave", scope: { kind: "global" }, key: "node", rule: "{}", enabled: true })).toMatchObject({ key: "node" });
    expect(() => baselinesActionArg({ kind: "ruleSave", scope: { kind: "global" }, key: "a b", rule: "{}", enabled: true })).toThrow();
    expect(() => baselinesActionArg({ kind: "ruleSave", scope: { kind: "global" }, key: "k", rule: "x".repeat(20_000), enabled: true })).toThrow();
    expect(baselinesActionArg({ kind: "ruleRemove", scope: { kind: "repo", slug: "a/b" }, key: "k" })).toMatchObject({ kind: "ruleRemove" });
    expect(() => baselinesActionArg({ kind: "drop" })).toThrow();
    expect(legacyActionArg({ kind: "run", checkId: 3, slug: "a/b" })).toEqual({ kind: "run", checkId: 3, slug: "a/b" });
    expect(legacyActionArg({ kind: "cancel", scanId: 1 })).toEqual({ kind: "cancel", scanId: 1 });
    expect(() => legacyActionArg({ kind: "run", checkId: 0, slug: "a/b" })).toThrow();
    expect(legacyViolationsArg({ scanId: 2 })).toEqual({ scanId: 2, offset: 0, limit: 200 });
    expect(() => legacyViolationsArg({ scanId: 2, limit: 5000 })).toThrow();
    expect(checkExportActionArg({ kind: "run", checkKey: "ck_a", slug: "a/b" })).toEqual({ kind: "run", checkKey: "ck_a", slug: "a/b" });
    expect(checkExportActionArg({ kind: "push", id: 4 })).toEqual({ kind: "push", id: 4 });
    expect(() => checkExportActionArg({ kind: "merge", id: 4 })).toThrow();
  });
});

describe("admission IPC arguments (workstream D)", () => {
  it("checks the scope, wizard actions and calibration actions", async () => {
    const { admissionScopeArg, wizardActionArg, calibrationActionArg, calibrationSinceArg } = await import("./validate");
    expect(admissionScopeArg({ kind: "all" })).toEqual({ kind: "all" });
    expect(admissionScopeArg({ kind: "repo", slug: "acme/web" })).toEqual({ kind: "repo", slug: "acme/web" });
    expect(admissionScopeArg({ kind: "product", productId: 3 })).toEqual({ kind: "product", productId: 3 });
    for (const bad of [null, {}, { kind: "repo" }, { kind: "product", productId: -1 }, { kind: "x" }]) expect(() => admissionScopeArg(bad)).toThrow();

    expect(wizardActionArg({ op: "start", scope: { kind: "all" } })).toEqual({ op: "start", scope: { kind: "all" } });
    expect(wizardActionArg({ op: "accept", runId: 4, extra: 1 })).toEqual({ op: "accept", runId: 4 });
    expect(wizardActionArg({ op: "pullBack", runId: 4, lessonIds: [1, 2] })).toEqual({ op: "pullBack", runId: 4, lessonIds: [1, 2] });
    for (const bad of [{ op: "accept" }, { op: "accept", runId: 0 }, { op: "pullBack", runId: 1, lessonIds: [] }, { op: "rejectGroup", runId: 1, lessonIds: ["a"] }, { op: "drop", runId: 1 }]) {
      expect(() => wizardActionArg(bad)).toThrow();
    }

    expect(calibrationSinceArg(null)).toBeNull();
    expect(calibrationSinceArg(5)).toBe(5);
    expect(() => calibrationSinceArg(-1)).toThrow();
    expect(calibrationActionArg({ op: "mark", lessonId: 2, mark: "good", since: 9 })).toEqual({ op: "mark", lessonId: 2, mark: "good", since: 9 });
    expect(calibrationActionArg({ op: "markCalibrated" })).toEqual({ op: "markCalibrated" });
    for (const bad of [{ op: "mark", lessonId: 2, mark: "great", since: 9 }, { op: "mark", lessonId: 2, mark: "good" }, { op: "other" }]) expect(() => calibrationActionArg(bad)).toThrow();
  });
});

describe("cost and background IPC args (workstream L)", () => {
  it("accepts a cost layer change and a subject, rejects anything else", () => {
    expect(costSetArg({ scope: { kind: "repo", slug: "acme/web" }, overrides: { sessionCap: 5 } })).toEqual({ scope: { kind: "repo", slug: "acme/web" }, overrides: { sessionCap: 5 } });
    expect(() => costSetArg({ scope: { kind: "global" }, overrides: [] })).toThrow();
    expect(() => costSetArg({ scope: { kind: "global" }, overrides: {}, extra: 1 })).toThrow();
    expect(costSubjectArg({ subjectKind: "ticket", subjectId: "T-1" })).toEqual({ subjectKind: "ticket", subjectId: "T-1" });
    expect(costSubjectArg({ subjectKind: "session", subjectId: "abc-1" })).toEqual({ subjectKind: "session", subjectId: "abc-1" });
    expect(() => costSubjectArg({ subjectKind: "session", subjectId: "a b" })).toThrow();
    expect(() => costSubjectArg({ subjectKind: "repo", subjectId: "x" })).toThrow();
  });

  it("accepts pausing a known background kind only", () => {
    expect(backgroundActionArg({ op: "pauseKind", kind: "lesson_backfill" })).toEqual({ op: "pauseKind", kind: "lesson_backfill" });
    expect(() => backgroundActionArg({ op: "pauseKind", kind: "nope" })).toThrow();
    expect(() => backgroundActionArg({ op: "drop", kind: "lesson_backfill" })).toThrow();
  });
});

describe("comment and CI loop arguments", () => {
  it("validates a loop policy change", () => {
    expect(loopSetArg({ scope: { kind: "repo", slug: "o/r" }, overrides: { "ci.maxReruns": 1, "comments.enabled": true } }))
      .toEqual({ scope: { kind: "repo", slug: "o/r" }, overrides: { "ci.maxReruns": 1, "comments.enabled": true } });
    expect(() => loopSetArg({ scope: { kind: "global" }, overrides: { "ci.maxReruns": 9 } })).toThrow();
    expect(() => loopSetArg({ scope: { kind: "global" }, overrides: { nope: true } })).toThrow();
    expect(() => loopSetArg({ scope: { kind: "global" }, overrides: { "ci.envPatterns": ["/(/"] } })).toThrow();
  });

  it("validates a comment action", () => {
    expect(commentActionArg({ op: "send", id: 3 })).toEqual({ op: "send", id: 3 });
    expect(commentActionArg({ op: "categorize", id: 3, category: "ignore" })).toEqual({ op: "categorize", id: 3, category: "ignore" });
    for (const bad of [{ op: "send", id: 0 }, { op: "categorize", id: 3, category: "x" }, { op: "dismiss", id: 3, category: "fix" }, { op: "zap", id: 3 }, { op: "send", id: 3, extra: 1 }]) {
      expect(() => commentActionArg(bad)).toThrow();
    }
  });

  it("validates a flaky list change", () => {
    expect(flakyActionArg({ op: "add", repoSlug: "o/r", kind: "test", name: " a.spec " })).toEqual({ op: "add", repoSlug: "o/r", kind: "test", name: "a.spec" });
    for (const bad of [{ op: "add", repoSlug: "o/r", kind: "job", name: "a" }, { op: "add", repoSlug: "", kind: "test", name: "a" }, { op: "add", repoSlug: "o/r", kind: "test", name: " " }]) {
      expect(() => flakyActionArg(bad)).toThrow();
    }
  });
});

describe("conversation store arguments (UI redesign layer 4)", () => {
  it("convListOptsArg keeps valid options and caps the limit", () => {
    expect(convListOptsArg({ limit: 50 })).toEqual({ limit: 50 });
    expect(convListOptsArg({ limit: 500 })).toEqual({ limit: CONV_LIST_MAX });
    expect(convListOptsArg({ limit: 20, before: 7, qaOnly: true })).toEqual({ limit: 20, before: 7, qaOnly: true });
    for (const bad of [{ limit: 0 }, { limit: 1.5 }, { limit: 10, before: -1 }, { limit: 10, before: 1.5 }, { limit: 10, qaOnly: "y" }, null, "x", { limit: "10" }]) {
      expect(() => convListOptsArg(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("convQueryArg cuts long queries and refuses non-strings", () => {
    expect([...convQueryArg("搜".repeat(300))]).toHaveLength(CONV_QUERY_MAX);
    expect(convQueryArg("lint")).toBe("lint");
    expect(() => convQueryArg(42)).toThrow();
  });

  it("convRootArg takes null or a session id", () => {
    expect(convRootArg(null)).toBeNull();
    expect(convRootArg("a-1")).toBe("a-1");
    expect(() => convRootArg("../x")).toThrow();
    expect(() => convRootArg(undefined)).toThrow();
  });
});

describe("turn args (UI redesign layer 1)", () => {
  it("turnFilterArg: null for nothing, one key at most", () => {
    expect(turnFilterArg(undefined)).toBeNull();
    expect(turnFilterArg(null)).toBeNull();
    // 以前的 epic 范围（BTL-246 去掉了）：别的键一样不看。
    expect(turnFilterArg({ epicId: 2 })).toBeNull();
    expect(turnFilterArg({ featureId: 5 })).toEqual({ featureId: 5 });
    expect(turnFilterArg({ ticketKey: "BTL-1" })).toEqual({ ticketKey: "BTL-1" });
    // 和 TurnFilter 类型、normTurnFilter 一致：值为 undefined 的键不算；都给时按 ticketKey > featureId 取一个；别的键不看
    expect(turnFilterArg({ ticketKey: "BTL-1", featureId: undefined })).toEqual({ ticketKey: "BTL-1" });
    expect(turnFilterArg({ featureId: 2, ticketKey: "K" })).toEqual({ ticketKey: "K" });
    expect(turnFilterArg({ foo: 1 })).toBeNull();
    expect(turnFilterArg({ featureId: undefined })).toBeNull();
    for (const bad of [{ featureId: 0 }, { featureId: 1.5 }, { ticketKey: "K", featureId: "x" }, { ticketKey: "" }, { ticketKey: "x".repeat(201) }, [], "x", 3]) {
      expect(() => turnFilterArg(bad), JSON.stringify(bad)).toThrow();
    }
  });
  it("turnSendArg: picks ticketKey and pr {repo, number}; a TurnItem's pr with title and url is fine", () => {
    const ok = { ticketKey: "BTL-1", pr: { repo: "o/r", number: 3 } };
    expect(turnSendArg(ok)).toEqual(ok);
    expect(turnSendArg({ ...ok, pr: { ...ok.pr, title: "T", url: "u" }, extra: 1 })).toEqual(ok);
    for (const bad of [
      { ticketKey: "BTL-1" }, { ...ok, pr: { repo: "o/r", number: 1.5 } }, { ...ok, pr: { repo: "o/r" } },
      { ...ok, pr: { repo: "", number: 3 } }, { ...ok, ticketKey: "" }, null, [],
    ]) {
      expect(() => turnSendArg(bad), JSON.stringify(bad)).toThrow();
    }
  });

});

describe("fork and report args (UI redesign layer 5)", () => {
  it("forkIdArg takes only a positive integer", () => {
    expect(forkIdArg(1)).toBe(1);
    expect(forkIdArg(42)).toBe(42);
    for (const bad of [0, -1, 1.5, "1", null, undefined, Number.NaN, 2 ** 60]) expect(() => forkIdArg(bad), String(bad)).toThrow();
  });

  it("forkQuestionArg trims, refuses blank and over-long questions", () => {
    expect(forkQuestionArg("  为什么用 sqlite？ ")).toBe("为什么用 sqlite？");
    expect(forkQuestionArg("问".repeat(FORK_QUESTION_MAX))).toHaveLength(FORK_QUESTION_MAX);
    // 按字算：emoji 是两个 UTF-16 单元，也只算一个字。
    expect([...forkQuestionArg("😀".repeat(FORK_QUESTION_MAX))]).toHaveLength(FORK_QUESTION_MAX);
    for (const bad of ["  ", "", "x".repeat(FORK_QUESTION_MAX + 1), 5, null, undefined, ["q"]]) {
      expect(() => forkQuestionArg(bad), typeof bad === "string" ? `len ${bad.length}` : String(bad)).toThrow();
    }
  });

  it("reportsPageArg takes limit 1–100 and an optional positive before", () => {
    expect(reportsPageArg({ limit: 1 })).toEqual({ limit: 1 });
    expect(reportsPageArg({ limit: 100, before: 1_700_000_000_000 })).toEqual({ limit: 100, before: 1_700_000_000_000 });
    for (const bad of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "10" }, { limit: 10, before: 0 }, { limit: 10, before: -5 }, { limit: 10, before: 1.5 }, { limit: 10, before: "1" }, {}, null, "x", []]) {
      expect(() => reportsPageArg(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("devMessageArg keeps the text as typed; refuses blank and longer than TASK_LIMIT", () => {
    expect(devMessageArg(" 先别合 \n等 CI ")).toBe(" 先别合 \n等 CI ");
    expect(devMessageArg("x".repeat(TASK_LIMIT))).toHaveLength(TASK_LIMIT);
    for (const bad of [" \n ", "", "x".repeat(TASK_LIMIT + 1), 1, null, undefined]) expect(() => devMessageArg(bad)).toThrow();
  });
});

describe("closeTicketArg (BTL-270)", () => {
  it("needs a reason and refuses one over the limit instead of cutting it", () => {
    expect(closeTicketArg({ reason: "需求变了" })).toEqual({ reason: "需求变了", closePrs: false, endSessions: false });
    expect(closeTicketArg({ reason: "x", closePrs: true, endSessions: true })).toEqual({ reason: "x", closePrs: true, endSessions: true });
    expect(() => closeTicketArg({ reason: "  " })).toThrow();
    expect(() => closeTicketArg({ reason: "x".repeat(501) })).toThrow();
    expect(() => closeTicketArg({ reason: "x", closePrs: "yes" })).toThrow();
    expect(() => closeTicketArg(null)).toThrow();
  });

  it("takes the PRs ticked in the dialog, refusing too many instead of cutting the list", () => {
    const urls = Array.from({ length: CLOSE_RETRY_MAX }, (_, i) => `https://github.com/o/r/pull/${i + 1}`);
    expect(closeTicketArg({ reason: "x", closePrs: true, prUrls: urls })).toEqual({ reason: "x", closePrs: true, endSessions: false, prUrls: urls });
    expect(closeTicketArg({ reason: "x", closePrs: true, prUrls: [] })).toEqual({ reason: "x", closePrs: true, endSessions: false, prUrls: [] });
    expect(() => closeTicketArg({ reason: "x", closePrs: true, prUrls: [...urls, "https://github.com/o/r/pull/999"] })).toThrow();
    expect(() => closeTicketArg({ reason: "x", prUrls: "https://github.com/o/r/pull/1" })).toThrow();
    expect(() => closeTicketArg({ reason: "x", prUrls: [42] })).toThrow();
  });

  it("takes the PR links and session ids to retry, refusing too many instead of dropping the rest", () => {
    expect(closeRetryArg({ prUrls: ["https://github.com/o/r/pull/1"], sessionIds: ["s-1"] })).toEqual({ prUrls: ["https://github.com/o/r/pull/1"], sessionIds: ["s-1"] });
    expect(closeRetryArg({})).toEqual({ prUrls: [], sessionIds: [] });
    expect(() => closeRetryArg({ prUrls: Array.from({ length: CLOSE_RETRY_MAX + 1 }, (_, i) => `u${i}`) })).toThrow();
    expect(() => closeRetryArg({ sessionIds: ["a b"] })).toThrow();
    expect(() => closeRetryArg({ prUrls: "x" })).toThrow();
    expect(() => closeRetryArg(null)).toThrow();
  });
});

describe("info flow args (BTL-272)", () => {
  it("accepts a scope, an id and one of the four acts, and nothing else", () => {
    expect(flowScopeArg({ all: true })).toEqual({ all: true });
    expect(flowScopeArg({ featureId: 3 })).toEqual({ featureId: 3 });
    for (const bad of [null, {}, { all: "yes" }, { featureId: -1 }, "all"]) expect(() => flowScopeArg(bad)).toThrow();
    expect(flowIdArg(7)).toBe(7);
    for (const bad of [0, -2, 1.5, "7", null]) expect(() => flowIdArg(bad)).toThrow();
    for (const ok of ["apply", "reject", "undo", "dismiss"]) expect(flowActArg(ok)).toBe(ok);
    for (const bad of ["delete", "", 1, null]) expect(() => flowActArg(bad)).toThrow();
  });
});

describe("messageIdArg (BTL-269 mailbox message ids)", () => {
  it("accepts a UUID and other safe ids", () => {
    expect(messageIdArg("0b6f3c1e-8f2a-4d6b-9c1e-2f3a4b5c6d7e")).toBe("0b6f3c1e-8f2a-4d6b-9c1e-2f3a4b5c6d7e");
    expect(messageIdArg("a")).toBe("a");
    expect(messageIdArg("x".repeat(100))).toBe("x".repeat(100));
  });
  it("rejects anything else: not a string, empty, too long, unsafe characters", () => {
    for (const v of [undefined, null, 1, {}, ["a"], "", "x".repeat(101), "a b", "a/b", "../x", "a;b", "a\nb", "ａ"]) {
      expect(() => messageIdArg(v), JSON.stringify(v)).toThrow("invalid message id");
    }
  });
});
