import { NOTE_BODY_LIMIT } from "./memory";
/**
 * 信息流转（BTL-272）：每个 session 每轮结束后从对话里抽出要点，写进记忆、发给需要知道的 session，
 * 对话里说的状态变化（ticket 不做了、换 feature、先做哪个）同步到 Shipherd。渲染进程也 import：这里不能 import Node 模块或 zod。
 */
import type { ClosePrErrorKind } from "./types";

/** 要点的种类：决定、约定、限制、状态变化、知会一声。 */
export const FLOW_KINDS = ["decision", "convention", "constraint", "state_change", "fyi"] as const;
export type FlowKind = (typeof FLOW_KINDS)[number];

/** 重要程度：high 叫醒休眠的 session；normal 排队等打开；low 只写记忆，不发。 */
export const FLOW_IMPORTANCE = ["high", "normal", "low"] as const;
export type FlowImportance = (typeof FLOW_IMPORTANCE)[number];

/** 谁说的：用户还是 agent。 */
export type FlowSpeaker = "user" | "agent";

/**
 * 发给谁（解析好的）：某个 ticket、某个 epic（内部叫 feature）、整个 workspace、某个 epic 的总控或全局总控（featureId 为 null）。
 */
export type FlowTarget =
  | { kind: "ticket"; key: string }
  | { kind: "epic"; featureId: number }
  | { kind: "workspace" }
  | { kind: "coordinator"; featureId: number | null };

/** 对话里说的、能同步到 Shipherd 的状态变化。 */
export type FlowChange =
  | {
      op: "close_ticket"; ticket: string; reason: string; closePrs: boolean;
      /**
       * closePrs 时提出来那一刻能关的 PR（卡片上列给你看的那几个）：确认后只关这些（BTL-270：路由要关 PR 必须点名）。
       * unclosable 是那时关不了的和原因，只给你看。
       */
      prUrls?: string[];
      unclosable?: { url: string; error: string }[];
    }
  | { op: "set_ticket_feature"; ticket: string; blockId: number | null }
  | { op: "prioritize_feature"; featureId: number; blockId: number };

/** 状态变化的处理：auto 自动执行了；confirm 等用户确认。 */
export type FlowActionMode = "auto" | "confirm";
/**
 * pending 等确认；applied 执行了；already 已经是这个状态（比如 agent 自己用工具做过了）；rejected 用户不要；
 * undone 撤销了；failed 执行出错；stale 等确认的时候情况变了（ticket 没了之类）。
 */
/**
 * partial：ticket 关了，但有 PR 没关上（或 session 没结束），不算完成：要点先不记不发，等你重试或者「就这样」（BTL-270 的同一个判断）。
 */
export type FlowActionState = "pending" | "applied" | "partial" | "already" | "rejected" | "undone" | "failed" | "stale";

/** partial 时没处理完的，逐条列在卡片上。 */
export interface FlowLeftovers {
  prErrors: { url: string; error: string; kind: ClosePrErrorKind }[];
  sessionErrors: { id: string; error: string }[];
  /** 关的时候别人（总控、你在关闭框里）先关了这个 ticket（BTL-270 的 closedMeanwhile 是 failed）：ticket 不是这里关的，不给撤销。 */
  closedMeanwhile?: true;
}

/**
 * 写记忆的结果：written 写了；dup 已经有了（不写、不发）；full 没空位；failed 出错；skipped 这种不写（fyi）；disabled 记忆关着；
 * pending 还没写完（重启后接着写）；held 状态变化等你确认，确认了再记、再发；dropped 你没要、或者情况变了，不记不发。
 */
export type FlowMemoryState = "written" | "dup" | "full" | "failed" | "skipped" | "disabled" | "pending" | "held" | "dropped" | "retracted";

export interface FlowDeliveryView {
  toSession: string;
  /** 给人看的接收方。 */
  to: string;
  /** 信箱里的状态；消息已经过期删掉为 null。 */
  status: "queued" | "delivered" | "replied" | null;
  deliveredAt: string | null;
}

export interface FlowActionView {
  id: number;
  change: FlowChange;
  /** 给人看的一句话：「关掉 BTL-12」。 */
  label: string;
  mode: FlowActionMode;
  state: FlowActionState;
  error: string | null;
  /** partial 时没处理完的；别的状态为 null。 */
  leftovers: FlowLeftovers | null;
  /** 能撤销：执行了，而且有撤销的办法。 */
  undoable: boolean;
  decidedAt: string | null;
}

/** 界面上的一条要点。时间是 ISO 字符串。 */
export interface FlowItemView {
  id: number;
  text: string;
  kind: FlowKind;
  speaker: FlowSpeaker;
  importance: FlowImportance;
  confidence: number;
  /** 来源 session（head 那一刻的 id）和它给人看的名字。 */
  sourceSession: string;
  source: string;
  /** 对话里的那一轮（conv_turns.id），点进去看原话用。 */
  turnId: number;
  targets: string[];
  /** 写进了哪一级记忆（"ticket:BTL-12" 之类）；没写为 null。 */
  scope: string | null;
  memory: FlowMemoryState;
  deliveries: FlowDeliveryView[];
  action: FlowActionView | null;
  createdAt: string;
}

/** 列表范围：全部（全局总控页），或者一个 epic 的。 */
export type FlowScope = { all: true } | { featureId: number };

/** 原话：那一轮双方说的话。 */
export interface FlowTurnText {
  turnId: number;
  messages: { role: "user" | "assistant"; text: string; at: string }[];
}

/** 每轮抽多少条最多。 */
export const FLOW_MAX_ITEMS = 8;
/** 记忆里来源注记（「（来自 X 的对话）」）里的 session 名字最多这么多 UTF-16 单位。 */
export const FLOW_SOURCE_NAME_LIMIT = 40;
/** 来源注记最长多少（名字到上限时，中英两种写法里长的那个）。 */
export const FLOW_NOTE_SUFFIX_MAX = 64;
/**
 * 一条要点最多这么多 UTF-16 单位：加上来源注记也放得进一条记忆（NOTE_BODY_LIMIT），写进去不会被截掉，
 * 撤销时才认得出是这一条（截掉了就对不上、忘不掉）。
 */
export const FLOW_TEXT_LIMIT = NOTE_BODY_LIMIT - FLOW_NOTE_SUFFIX_MAX;
/** 最近 24 小时最多问模型这么多次；到了就停，「现在」页上说一声，等最早的那次过了 24 小时再接着问。 */
export const FLOW_DAILY_ASKS = 300;
export const FLOW_DAY_MS = 24 * 60 * 60_000;
/** 自动执行状态变化要的最低置信度。 */
export const FLOW_AUTO_CONFIDENCE = 0.85;
/** 低于这个置信度的要点丢掉。 */
export const FLOW_MIN_CONFIDENCE = 0.5;
