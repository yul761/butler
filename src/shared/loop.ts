/** 评论闭环和 CI 分类（工作流 I）给界面和 H 的「效果」页用的类型。 */

export const COMMENT_CATEGORIES = ["fix", "question", "ignore", "human"] as const;
export type CommentCategory = (typeof COMMENT_CATEGORIES)[number];

export type CommentKind = "inline" | "review" | "issue";
export type CommentWho = "copilot" | "human" | "bot" | "author";
export type CommentSource = "rule" | "model" | "user";

/**
 * pending：还没分类；review：等你看（人的评论、在提问、需要人判断）；queued：等着送进 session；delivered：送进去了，等 push；
 * addressed：push 之后位置变了（已处理）；ignored：可忽略；dismissed：你点了忽略；closed：thread 在别处 resolve 了，或者 PR 关了。
 */
export const COMMENT_STATES = ["pending", "review", "queued", "delivered", "addressed", "ignored", "dismissed", "closed"] as const;
export type CommentState = (typeof COMMENT_STATES)[number];

/** 位置核对的结果：outdated（GitHub 标了过时）、patch（这几行被改了）、commit（没有位置，送达后有新 commit）。 */
export type CommentVerified = "outdated" | "patch" | "commit";

export interface CommentItemView {
  id: number;
  prId: number;
  /** 评论键：行内评论是 REST 的数字 id，review 正文是 review:<id>，PR 级评论是 issue:<id>。 */
  key: string;
  kind: CommentKind;
  author: string;
  who: CommentWho;
  path: string | null;
  line: number | null;
  body: string;
  url: string | null;
  category: CommentCategory | null;
  source: CommentSource | null;
  /** 规则的理由码（outdated、answered、ack、pattern、suggestion、overview、model_failed、unchanged_twice…）或模型的一句话。 */
  reason: string | null;
  state: CommentState;
  firstSeen: number;
  deliveredAt: number | null;
  deliveredSession: string | null;
  addressedAt: number | null;
  verified: CommentVerified | null;
  repliedAt: number | null;
  resolvedAt: number | null;
  replyError: string | null;
}

/** ticket 页「评论」标签：每个 PR 一组。 */
export interface PrCommentsView {
  prId: number;
  number: number;
  url: string;
  enabled: boolean;
  items: CommentItemView[];
}

export type CommentAction =
  | { op: "send"; id: number }
  | { op: "categorize"; id: number; category: CommentCategory }
  | { op: "dismiss"; id: number }
  | { op: "reply"; id: number };

/** 「现在」页：等你看分类的评论。 */
export interface CommentsWaiting {
  ticketKey: string;
  prId: number;
  number: number;
  count: number;
  since: number;
}

export type FlakyKind = "check" | "test";

export interface FlakyEntry {
  repoSlug: string;
  kind: FlakyKind;
  name: string;
  /** 窗口内 flaky 的次数和浪费的时间。 */
  count: number;
  wastedMs: number;
  lastAt: number | null;
  listed: "auto" | "manual" | null;
}

export type FlakyAction =
  | { op: "add"; repoSlug: string; kind: FlakyKind; name: string }
  | { op: "remove"; repoSlug: string; kind: FlakyKind; name: string };

/** 给 H 的「效果」页（设计补充第 5 节）。 */
export interface LoopEffect {
  since: number;
  until: number;
  comments: {
    autoHandled: number;
    byWho: { copilot: number; human: number };
    delivered: number;
    replied: number;
    resolved: number;
    waitingForYou: number;
  };
  ci: {
    triaged: number;
    byCategory: { env: number; flaky: number; code: number };
    reruns: number;
    passedAfterRerun: number;
    deliveredAsCode: number;
    possiblyFlaky: number;
    flakyWastedMs: number;
    topFlaky: { repoSlug: string; kind: FlakyKind; name: string; count: number; wastedMs: number; listed: boolean }[];
  };
}
