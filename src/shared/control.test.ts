import { describe, expect, it } from "vitest";
import { MAX_CREATE_REPOS, MAX_STACK_LAYERS, MESSAGE_LIMIT, parseControlRequest, REASON_LIMIT, sanitizeTask, taskMessage, TASK_LIMIT } from "./control";

describe("parseControlRequest", () => {
  it("accepts a ticket session's own requests, and none of the old ticket coordinator's (BTL-246)", () => {
    expect(parseControlRequest({ v: 1, ticketKey: "P-1", from: "s1", op: "pre_review_result" })).toEqual({ v: 1, ticketKey: "P-1", from: "s1", op: "pre_review_result" });
    expect(parseControlRequest({ v: 1, ticketKey: "P-1", op: "report", text: "done", kind: "done" })).toMatchObject({ op: "report", from: null });
    for (const op of ["list_repos", "list_sessions", "session_activity", "end_session", "refresh_session"]) {
      expect(parseControlRequest({ v: 1, ticketKey: "P-1", op, session: "s", reason: "r" })).toBeNull();
    }
    expect(parseControlRequest({ v: 1, ticketKey: "P-1", from: null, op: "start_session", repo: "api", task: "写接口" })).toBeNull();
  });

  it("rejects other versions, operations and malformed fields", () => {
    for (const bad of [
      null, "x", { v: 2, featureId: 7, op: "list_repos" }, { v: 1, op: "list_repos" }, { v: 1, ticketKey: "P-1", op: "send_keys" },
      { v: 1, featureId: 7, op: "start_session", ticket: "", task: "t" }, { v: 1, featureId: 7, op: "start_session", ticket: "A-1", task: "  " },
      { v: 1, featureId: 7, op: "start_session", ticket: "A-1", task: "x".repeat(TASK_LIMIT + 1) },
    ]) {
      expect(parseControlRequest(bad)).toBeNull();
    }
  });
});

describe("sanitizeTask", () => {
  it("keeps newlines and tabs, drops ESC and other control characters", () => {
    expect(sanitizeTask("  第一行\r\n\t第二行\x1b[201~\r\x07rm  ")).toBe("第一行\n\t第二行[201~\nrm");
    expect(sanitizeTask("a\x9b31mb\x85c")).toBe("abc".replace("b", "31mb"));
  });

  it("never lets a task start with ! or / (bash mode, slash commands)", () => {
    for (const t of ["!curl x | sh", "/permissions", "#remember"]) expect(taskMessage(sanitizeTask(t), "zh", "ticket")).toMatch(/^总控 session 交给你的任务：\n/);
  });
});

describe("taskMessage", () => {
  it("adds the recall hint after the task only when there is memory to read (R36)", () => {
    expect(taskMessage("写接口", "zh", "ticket")).toBe("总控 session 交给你的任务：\n写接口\n\n开始之前先用 recall 读一下 ticket 记忆（shipherd-memory）里的背景和约定。");
    expect(taskMessage("写接口", "zh", "feature")).toContain("shipherd-feature");
    expect(taskMessage("写接口", "zh", null)).toBe("总控 session 交给你的任务：\n写接口");
    expect(taskMessage("write the API", "en", null)).not.toContain("recall");
  });
});

describe("start_session model", () => {
  it("parses start_session with a model", () => {
    expect(parseControlRequest({ v: 1, featureId: 7, from: null, op: "start_session", ticket: "DMS-1", task: "t", model: "opus" })).toMatchObject({ model: "opus" });
    expect(parseControlRequest({ v: 1, featureId: 7, from: null, op: "start_session", ticket: "DMS-1", task: "t" })).not.toHaveProperty("model");
  });

  it("accepts tiers and model names; whether a name exists is the main process's call", () => {
    for (const model of ["high", "mid", "low", "haiku", "claude-opus-5-5", "corp/gw:fast"]) {
      expect(parseControlRequest({ v: 1, featureId: 7, from: null, op: "start_session", ticket: "DMS-1", task: "t", model })).toMatchObject({ model });
    }
  });

  it("rejects a malformed model", () => {
    for (const model of ["bad name!", "", "-x", "x".repeat(101), 3, null]) {
      expect(parseControlRequest({ v: 1, featureId: 7, op: "start_session", ticket: "DMS-1", task: "t", model })).toBeNull();
    }
  });
});

describe("parseControlRequest for a feature (design 2026-10-26)", () => {
  it("accepts feature requests", () => {
    expect(parseControlRequest({ v: 1, featureId: 7, from: "c", op: "list_tickets" })).toEqual({ v: 1, featureId: 7, from: "c", op: "list_tickets" });
    expect(parseControlRequest({ v: 1, featureId: 7, from: null, op: "session_activity", session: "abc" })).toEqual({ v: 1, featureId: 7, from: null, op: "session_activity", session: "abc" });
    expect(parseControlRequest({ v: 1, featureId: 7, op: "session_activity" })).toBeNull();
    expect(parseControlRequest({ v: 1, featureId: 7, op: "session_activity", session: 3 })).toBeNull();
    expect(parseControlRequest({ v: 1, featureId: 7, from: null, op: "list_sessions" })).toEqual({ v: 1, featureId: 7, from: null, op: "list_sessions" });
    expect(parseControlRequest({ v: 1, featureId: 7, from: null, op: "start_session", ticket: "DMS-1", task: "t" })).toEqual({
      v: 1, featureId: 7, from: null, op: "start_session", ticket: "DMS-1", task: "t",
    });
    expect(parseControlRequest({ v: 1, featureId: 7, from: null, op: "start_session", ticket: "DMS-1", repo: "fe", task: "t" })).toMatchObject({ repo: "fe" });
  });

  it("rejects a feature id that is not a positive integer, both scopes at once, and ops of the other scope", () => {
    for (const featureId of ["1", 0, -1, 1.5, null]) expect(parseControlRequest({ v: 1, featureId, from: null, op: "list_tickets" }), String(featureId)).toBeNull();
    expect(parseControlRequest({ v: 1, featureId: 7, ticketKey: "A-1", from: null, op: "list_sessions" })).toBeNull();
    expect(parseControlRequest({ v: 1, ticketKey: "A-1", from: null, op: "list_tickets" })).toBeNull();
    expect(parseControlRequest({ v: 1, ticketKey: "A-1", from: null, op: "create_ticket", ticket: "A-2" })).toBeNull();
    expect(parseControlRequest({ v: 1, featureId: 7, from: null, op: "start_session", task: "t" })).toBeNull();
  });

  it("accepts list_repos and create_ticket, dropping unknown fields", () => {
    expect(parseControlRequest({ v: 1, featureId: 7, from: null, op: "list_repos", repo: "x" })).toEqual({ v: 1, featureId: 7, from: null, op: "list_repos" });
    expect(parseControlRequest({ v: 1, featureId: 7, from: "c", op: "create_ticket", ticket: "DMS-9" })).toEqual({ v: 1, featureId: 7, from: "c", op: "create_ticket", ticket: "DMS-9" });
    expect(parseControlRequest({ v: 1, featureId: 7, from: null, op: "create_ticket", ticket: "DMS-9", title: "", repos: ["fe", "be"], branch: "b", x: 1 })).toEqual({
      v: 1, featureId: 7, from: null, op: "create_ticket", ticket: "DMS-9", title: "", repos: ["fe", "be"], branch: "b",
    });
  });

  it("rejects malformed create_ticket requests", () => {
    const base = { v: 1, featureId: 7, from: null, op: "create_ticket" };
    expect(parseControlRequest({ ...base })).toBeNull();
    expect(parseControlRequest({ ...base, ticket: "" })).toBeNull();
    expect(parseControlRequest({ ...base, ticket: "A-1", title: 5 })).toBeNull();
    expect(parseControlRequest({ ...base, ticket: "A-1", title: "x".repeat(501) })).toBeNull();
    expect(parseControlRequest({ ...base, ticket: "A-1", branch: "" })).toBeNull();
    expect(parseControlRequest({ ...base, ticket: "A-1", repos: "fe" })).toBeNull();
    expect(parseControlRequest({ ...base, ticket: "A-1", repos: ["fe", 3] })).toBeNull();
    expect(parseControlRequest({ ...base, ticket: "A-1", repos: Array.from({ length: MAX_CREATE_REPOS + 1 }, (_, i) => `r${i}`) })).toBeNull();
  });
});

describe("parseControlRequest for features inside an epic (blocks, BTL-246)", () => {
  const base = { v: 1, featureId: 7, from: "c" } as const;
  it("accepts list_features, create_feature, reorder_features and set_ticket_feature", () => {
    expect(parseControlRequest({ ...base, op: "list_features", x: 1 })).toEqual({ ...base, op: "list_features" });
    expect(parseControlRequest({ ...base, op: "create_feature", name: "Payment" })).toEqual({ ...base, op: "create_feature", name: "Payment" });
    expect(parseControlRequest({ ...base, op: "create_feature", name: " Payment ", description: "cards first", before: "Refunds" })).toEqual({
      ...base, op: "create_feature", name: "Payment", description: "cards first", before: "Refunds",
    });
    // id 也可以是数字：统一成字符串。
    expect(parseControlRequest({ ...base, op: "create_feature", name: "P", before: 3 })).toMatchObject({ before: "3" });
    expect(parseControlRequest({ ...base, op: "reorder_features", order: ["B", 2, "A"] })).toEqual({ ...base, op: "reorder_features", order: ["B", "2", "A"] });
    expect(parseControlRequest({ ...base, op: "set_ticket_feature", ticket: "DMS-1", feature: "Payment" })).toEqual({ ...base, op: "set_ticket_feature", ticket: "DMS-1", feature: "Payment" });
    expect(parseControlRequest({ ...base, op: "set_ticket_feature", ticket: "DMS-1", feature: null })).toEqual({ ...base, op: "set_ticket_feature", ticket: "DMS-1", feature: null });
    expect(parseControlRequest({ ...base, op: "create_ticket", ticket: "DMS-9", feature: "Payment" })).toEqual({ ...base, op: "create_ticket", ticket: "DMS-9", feature: "Payment" });
  });

  it("rejects malformed block requests", () => {
    expect(parseControlRequest({ ...base, op: "create_feature" })).toBeNull();
    expect(parseControlRequest({ ...base, op: "create_feature", name: "   " })).toBeNull();
    expect(parseControlRequest({ ...base, op: "create_feature", name: "x".repeat(101) })).toBeNull();
    expect(parseControlRequest({ ...base, op: "create_feature", name: "P", description: 5 })).toBeNull();
    expect(parseControlRequest({ ...base, op: "create_feature", name: "P", description: "x".repeat(2001) })).toBeNull();
    expect(parseControlRequest({ ...base, op: "create_feature", name: "P", before: "" })).toBeNull();
    expect(parseControlRequest({ ...base, op: "reorder_features" })).toBeNull();
    expect(parseControlRequest({ ...base, op: "reorder_features", order: [] })).toBeNull();
    expect(parseControlRequest({ ...base, op: "reorder_features", order: "A,B" })).toBeNull();
    expect(parseControlRequest({ ...base, op: "reorder_features", order: ["A", {}] })).toBeNull();
    expect(parseControlRequest({ ...base, op: "set_ticket_feature", ticket: "DMS-1" })).toBeNull();
    expect(parseControlRequest({ ...base, op: "set_ticket_feature", feature: "P" })).toBeNull();
    expect(parseControlRequest({ ...base, op: "set_ticket_feature", ticket: "DMS-1", feature: 1.5 })).toBeNull();
    expect(parseControlRequest({ ...base, op: "create_ticket", ticket: "DMS-9", feature: "" })).toBeNull();
    // 只有 epic 总控有：ticket session 和 Shipherd 总控都不认。
    expect(parseControlRequest({ v: 1, ticketKey: "A-1", from: null, op: "create_feature", name: "P" })).toBeNull();
    expect(parseControlRequest({ v: 1, shipherd: true, from: null, op: "create_feature", name: "P" })).toBeNull();
  });
});

describe("parseControlRequest for a legacy epic session (BTL-246)", () => {
  it("refuses every request that names an epicId: the old epic layer is gone", () => {
    for (const bad of [
      { v: 1, epicId: 3, op: "list_features" }, { v: 1, epicId: 3, op: "create_feature", name: "c", brief: "b" },
      { v: 1, epicId: 3, op: "set_epic_plan", plan: "p" }, { v: 1, epicId: 3, op: "start_feature", feature: "c" },
      { v: 1, epicId: 3, op: "list_sessions" }, { v: 1, epicId: 3, op: "end_session", session: "s1", reason: "r" },
      { v: 1, epicId: 3, op: "ask_user", question: "q" }, { v: 1, epicId: 3, op: "report", text: "t" }, { v: 1, epicId: 4, op: "list_stacks" },
      { v: 1, featureId: 7, op: "epic_context" }, { v: 1, featureId: 7, op: "set_epic_plan", plan: "p" }, { v: 1, featureId: 3, op: "start_feature", feature: "c" },
    ]) {
      expect(parseControlRequest(bad), JSON.stringify(bad).slice(0, 80)).toBeNull();
    }
  });
});

describe("parseControlRequest for end_session (task 11)", () => {
  const scopes = [{ ticketKey: "P-1" }, { featureId: 7 }];
  // ticket 总控没有了（BTL-246）：end_session、refresh_session 只有 feature 总控有。
  const coordinatorScopes = [{ featureId: 7 }];

  it("accepts end_session from the coordinator scopes, with a reason up to the limit", () => {
    for (const scope of coordinatorScopes) {
      expect(parseControlRequest({ v: 1, ...scope, from: "c", op: "end_session", session: "s1", reason: "PR 已合并" })).toEqual({ v: 1, ...scope, from: "c", op: "end_session", session: "s1", reason: "PR 已合并" });
      expect(parseControlRequest({ v: 1, ...scope, op: "end_session", session: "s1", reason: "x".repeat(REASON_LIMIT) })).toMatchObject({ reason: "x".repeat(REASON_LIMIT) });
    }
  });

  it("rejects end_session without a reason, with a reason over the limit, or with a session that is not a string", () => {
    for (const scope of scopes) {
      for (const bad of [
        { session: "s1" }, { session: "s1", reason: "" }, { session: "s1", reason: "   " }, { session: "s1", reason: "x".repeat(REASON_LIMIT + 1) },
        { session: 5, reason: "done" }, { reason: "done" }, { session: "", reason: "done" }, { session: "s1", reason: 1 },
      ]) {
        expect(parseControlRequest({ v: 1, ...scope, op: "end_session", ...bad }), JSON.stringify({ scope, bad }).slice(0, 80)).toBeNull();
      }
    }
  });

  it("accepts refresh_session from the coordinator scopes, and rejects one without a session string (plan 16)", () => {
    for (const scope of coordinatorScopes) {
      expect(parseControlRequest({ v: 1, ...scope, from: "c", op: "refresh_session", session: "s1" })).toEqual({ v: 1, ...scope, from: "c", op: "refresh_session", session: "s1" });
      for (const bad of [{}, { session: "" }, { session: 5 }, { session: "x".repeat(201) }]) {
        expect(parseControlRequest({ v: 1, ...scope, op: "refresh_session", ...bad }), JSON.stringify({ scope, bad }).slice(0, 80)).toBeNull();
      }
    }
  });
});

describe("parseControlRequest for ask_user and report (BTL-190 2+3)", () => {
  const scopes = [{ ticketKey: "BTL-1" }, { featureId: 3 }];

  it("accepts ask_user in both scopes, dropping empty options and blank context", () => {
    for (const s of scopes) {
      expect(parseControlRequest({ v: 1, ...s, from: "s1", op: "ask_user", question: "Which?", options: ["A", "B"], context: "why" }))
        .toEqual({ v: 1, ...s, from: "s1", op: "ask_user", question: "Which?", options: ["A", "B"], context: "why" });
      expect(parseControlRequest({ v: 1, ...s, from: "s1", op: "ask_user", question: "Which?", options: [], context: "  " }))
        .toEqual({ v: 1, ...s, from: "s1", op: "ask_user", question: "Which?" });
    }
  });

  it("keeps a recommended option index within range and accepts the choice report kind (ws-j)", () => {
    const base = { v: 1, ticketKey: "BTL-1", from: "s1", op: "ask_user", question: "Which?" };
    expect(parseControlRequest({ ...base, options: ["A", "B"], recommended: 0 })).toMatchObject({ options: ["A", "B"], recommended: 0 });
    expect(parseControlRequest({ ...base, options: ["A", "B"], recommended: 2 })).toBeNull();
    expect(parseControlRequest({ ...base, recommended: 0 })).toBeNull();
    expect(parseControlRequest({ ...base, options: ["A", "B"], recommended: 0.5 })).toBeNull();
    expect(parseControlRequest({ v: 1, ticketKey: "BTL-1", from: "s1", op: "report", text: "picked A", kind: "choice" })).toMatchObject({ kind: "choice" });
  });

  it("rejects ask_user without a question, with too many or bad options, or an over-long context", () => {
    const base = { v: 1, ticketKey: "BTL-1", from: "s1", op: "ask_user" };
    expect(parseControlRequest({ ...base, question: " " })).toBeNull();
    expect(parseControlRequest({ ...base, question: "x".repeat(1001) })).toBeNull();
    expect(parseControlRequest({ ...base, question: "q", options: ["1", "2", "3", "4", "5", "6", "7"] })).toBeNull();
    expect(parseControlRequest({ ...base, question: "q", options: ["ok", ""] })).toBeNull();
    expect(parseControlRequest({ ...base, question: "q", options: "A" })).toBeNull();
    expect(parseControlRequest({ ...base, question: "q", context: "x".repeat(4001) })).toBeNull();
  });

  it("accepts report with a kind, defaulting to progress, and rejects unknown kinds or empty text", () => {
    for (const s of scopes) {
      expect(parseControlRequest({ v: 1, ...s, from: null, op: "report", text: "done it", kind: "done" }))
        .toEqual({ v: 1, ...s, from: null, op: "report", text: "done it", kind: "done" });
      expect(parseControlRequest({ v: 1, ...s, from: null, op: "report", text: "half way" }))
        .toEqual({ v: 1, ...s, from: null, op: "report", text: "half way", kind: "progress" });
    }
    expect(parseControlRequest({ v: 1, ticketKey: "BTL-1", from: null, op: "report", text: "x", kind: "finished" })).toBeNull();
    expect(parseControlRequest({ v: 1, ticketKey: "BTL-1", from: null, op: "report", text: "" })).toBeNull();
    expect(parseControlRequest({ v: 1, ticketKey: "BTL-1", from: null, op: "report", text: "x".repeat(4001) })).toBeNull();
  });
});

describe("parseControlRequest for the Shipherd 总控 (BTL-190 5)", () => {
  const base = { v: 1, shipherd: true } as const;

  it("accepts the read-only ops, session ops, send_message and the inbox ops", () => {
    for (const op of ["list_epics", "list_features", "list_prs", "list_sessions", "list_inbox"]) {
      expect(parseControlRequest({ ...base, from: "b", op })).toEqual({ v: 1, shipherd: true, from: "b", op });
    }
    expect(parseControlRequest({ ...base, op: "list_tickets" })).toEqual({ v: 1, shipherd: true, from: null, op: "list_tickets" });
    // epic 过滤（BTL-246：以前叫 feature）；旧的 feature 参数不认，丢掉。
    expect(parseControlRequest({ ...base, op: "list_tickets", epic: "checkout", feature: "7" }))
      .toEqual({ v: 1, shipherd: true, from: null, op: "list_tickets", epic: "checkout" });
    expect(parseControlRequest({ ...base, op: "list_features", epic: "checkout" })).toEqual({ v: 1, shipherd: true, from: null, op: "list_features", epic: "checkout" });
    expect(parseControlRequest({ ...base, op: "progress_overview" })).toEqual({ v: 1, shipherd: true, from: null, op: "progress_overview" });
    expect(parseControlRequest({ ...base, op: "progress_overview", epic: "Q4" })).toEqual({ v: 1, shipherd: true, from: null, op: "progress_overview", epic: "Q4" });
    expect(parseControlRequest({ ...base, op: "metrics_overview" })).toEqual({ v: 1, shipherd: true, from: null, op: "metrics_overview" });
    expect(parseControlRequest({ ...base, op: "metrics_overview", days: 365 })).toEqual({ v: 1, shipherd: true, from: null, op: "metrics_overview", days: 365 });
    expect(parseControlRequest({ ...base, from: "b", op: "refresh_epic_summary", epic: "3" }))
      .toEqual({ v: 1, shipherd: true, from: "b", op: "refresh_epic_summary", epic: "3" });
    expect(parseControlRequest({ ...base, op: "session_activity", session: "s1" })).toEqual({ v: 1, shipherd: true, from: null, op: "session_activity", session: "s1" });
    expect(parseControlRequest({ ...base, op: "refresh_session", session: "s1" })).toEqual({ v: 1, shipherd: true, from: null, op: "refresh_session", session: "s1" });
    expect(parseControlRequest({ ...base, op: "send_message", session: "s1", text: "先合 A" }))
      .toEqual({ v: 1, shipherd: true, from: null, op: "send_message", session: "s1", text: "先合 A" });
    expect(parseControlRequest({ ...base, op: "send_message", epic: "checkout", text: "先合 A" }))
      .toEqual({ v: 1, shipherd: true, from: null, op: "send_message", epic: "checkout", text: "先合 A" });
    expect(parseControlRequest({ ...base, op: "send_message", session: "s1", text: "x".repeat(MESSAGE_LIMIT) })).toMatchObject({ op: "send_message" });
    expect(parseControlRequest({ ...base, op: "ask_user", question: "合吗？" })).toEqual({ v: 1, shipherd: true, from: null, op: "ask_user", question: "合吗？" });
    expect(parseControlRequest({ ...base, op: "report", text: "巡检完了" })).toEqual({ v: 1, shipherd: true, from: null, op: "report", text: "巡检完了", kind: "progress" });
  });

  it("rejects anything that creates, deletes or ends, malformed fields, the old names, and shipherd next to another scope", () => {
    for (const bad of [
      { ...base, op: "create_feature", name: "c", brief: "b" }, { ...base, op: "create_ticket", ticket: "P-1" }, { ...base, op: "start_session", repo: "r", task: "t" },
      { ...base, op: "start_feature", feature: "c" }, { ...base, op: "end_session", session: "s", reason: "r" }, { ...base, op: "set_epic_plan", plan: "p" },
      { ...base, op: "set_ticket_feature", ticket: "P-1", feature: null },
      { ...base, op: "send_message", session: "s1" }, { ...base, op: "send_message", session: "s1", text: "  " },
      { ...base, op: "send_message", session: "s1", text: "x".repeat(MESSAGE_LIMIT + 1) }, { ...base, op: "send_message", text: "t" },
      // 以前的目标 feature（BTL-246 改叫 epic），和 session、epic 一起给的。
      { ...base, op: "send_message", feature: "checkout", text: "t" }, { ...base, op: "send_message", session: "s1", epic: "checkout", text: "t" },
      { ...base, op: "session_activity" }, { ...base, op: "list_tickets", epic: 3 }, { ...base, op: "list_features", epic: "" },
      { ...base, op: "refresh_feature_summary", feature: "3" }, { ...base, op: "refresh_epic_summary" }, { ...base, op: "refresh_epic_summary", epic: 3 }, { ...base, op: "progress_overview", epic: "" },
      { ...base, op: "metrics_overview", days: 0 }, { ...base, op: "metrics_overview", days: 366 }, { ...base, op: "metrics_overview", days: 2.5 }, { ...base, op: "metrics_overview", days: "7" },
      { v: 1, shipherd: "yes", op: "list_epics" }, { v: 1, shipherd: false, op: "list_epics" },
      { ...base, epicId: 3, op: "list_epics" }, { ...base, featureId: 3, op: "list_epics" }, { ...base, ticketKey: "P-1", op: "list_epics" },
      { v: 1, featureId: 3, op: "list_prs" }, { v: 1, ticketKey: "P-1", op: "send_message", session: "s", text: "t" },
    ]) {
      expect(parseControlRequest(bad), JSON.stringify(bad).slice(0, 80)).toBeNull();
    }
  });
});

describe("parseControlRequest for stacks (workstream K)", () => {
  it("accepts the four stack ops for a feature and Shipherd control", () => {
    for (const base of [{ v: 1, featureId: 2 }, { v: 1, shipherd: true }] as const) {
      expect(parseControlRequest({ ...base, op: "list_stacks" })).toEqual({ ...base, from: null, op: "list_stacks" });
      expect(parseControlRequest({ ...base, op: "stack_define", branches: ["a", "b"], repo: "shop", name: "n", stack: 3 }))
        .toEqual({ ...base, from: null, op: "stack_define", branches: ["a", "b"], repo: "shop", name: "n", stack: 3 });
      expect(parseControlRequest({ ...base, op: "stack_rebase", stack: 3 })).toEqual({ ...base, from: null, op: "stack_rebase", stack: 3 });
      expect(parseControlRequest({ ...base, op: "stack_layer_mode", stack: 3, branch: "b", mode: "draft" }))
        .toEqual({ ...base, from: null, op: "stack_layer_mode", stack: 3, branch: "b", mode: "draft" });
    }
  });

  it("rejects malformed stack requests", () => {
    const base = { v: 1, featureId: 2 } as const;
    expect(parseControlRequest({ ...base, op: "stack_define", branches: ["a"] })).toBeNull();
    expect(parseControlRequest({ ...base, op: "stack_define", branches: Array.from({ length: MAX_STACK_LAYERS + 1 }, (_, i) => `b${i}`) })).toBeNull();
    expect(parseControlRequest({ ...base, op: "stack_define", branches: ["a", ""] })).toBeNull();
    expect(parseControlRequest({ ...base, op: "stack_define", branches: ["a", "b"], stack: 0 })).toBeNull();
    expect(parseControlRequest({ ...base, op: "stack_rebase" })).toBeNull();
    expect(parseControlRequest({ ...base, op: "stack_rebase", stack: 1.5 })).toBeNull();
    expect(parseControlRequest({ ...base, op: "stack_layer_mode", stack: 1, branch: "b", mode: "ready" })).toBeNull();
  });

  it("gives a ticket session no stack ops, and parses create_ticket's stack_on", () => {
    expect(parseControlRequest({ v: 1, ticketKey: "P-1", op: "list_stacks" })).toBeNull();
    expect(parseControlRequest({ v: 1, featureId: 2, op: "create_ticket", ticket: "P-2", stack_on: "P-1" }))
      .toEqual({ v: 1, featureId: 2, from: null, op: "create_ticket", ticket: "P-2", stack_on: "P-1" });
    expect(parseControlRequest({ v: 1, featureId: 2, op: "create_ticket", ticket: "P-2", stack_on: 3 })).toBeNull();
  });
});
