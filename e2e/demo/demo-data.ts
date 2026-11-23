/**
 * 演示数据（BTL-251）：一个虚构的笔记应用「Fernleaf」要做离线模式。公司、人、仓库全是编的。
 * 英文给 README.md 用，中文给 README.zh-CN.md 用；ticket 号、仓库名、PR 号两份一样。
 */

export type DemoLang = "en" | "zh";

export interface DemoTicket {
  key: string;
  title: string;
  repo: "web" | "sync-api";
}

export interface DemoFeature {
  name: string;
  tickets: DemoTicket[];
}

export interface DemoData {
  epic: string;
  /** 在总控里描述这个 epic 的一句话。 */
  description: string;
  coordinatorBanner: string;
  coordinatorReply: string;
  features: DemoFeature[];
  /** 总控交给各 session 的任务（start_session 的 task），ticket 号 → 任务。 */
  tasks: Record<string, string>;
  /** FERN-101：开了 PR、CI 绿了。 */
  prTitle: string;
  doneReply: string;
  ciReply: string;
  /** 合并以后总控发给 FERN-101 的话，和它的回复（它回完停下，Shipherd 就马上重查这个 ticket 的 PR）。 */
  mergedNote: string;
  mergedReply: string;
  /** FERN-102：一直在干活（读代码、改代码、跑测试）。 */
  testCommand: string;
  syncTestCommand: string;
  /** FERN-103：问你一个问题，两个选项。 */
  question: string;
  options: [string, string];
  /** 问完（ask_user 立刻返回）这一轮回的话。 */
  askedSay: string;
  captions: { describe: string; split: string; sessions: string; yourTurn: string; merge: string; merged: string };
}

export const REPOS = ["web", "sync-api"] as const;
/** 虚构的 GitHub org。不用「fernleaf」：那是个真实的 GitHub 账号。 */
export const ORG = "fernleaf-notes";
export const PR_NUMBER = 42;
/** 已经开了 PR 的 ticket、在干活的 ticket、要问你的 ticket。 */
export const PR_TICKET = "FERN-101";
export const WORKING_TICKET = "FERN-102";
export const ASKING_TICKET = "FERN-103";
export const STARTED = [PR_TICKET, WORKING_TICKET, ASKING_TICKET];

const EN: DemoData = {
  epic: "Offline mode",
  description: "Let people keep writing notes with no connection, and sync everything when they're back online.",
  coordinatorBanner: "Epic coordinator · Offline mode",
  coordinatorReply: "Got it. I'll split this into 3 features and 5 tickets, then start the first three in parallel.",
  features: [
    { name: "Local storage", tickets: [
      { key: "FERN-101", title: "Cache notes in IndexedDB", repo: "web" },
      { key: "FERN-102", title: "Queue edits while offline", repo: "web" },
    ] },
    { name: "Sync", tickets: [
      { key: "FERN-103", title: "Replay queued edits on reconnect", repo: "sync-api" },
      { key: "FERN-104", title: "Conflict banner", repo: "web" },
    ] },
    { name: "Polish", tickets: [{ key: "FERN-105", title: "Offline badge in the toolbar", repo: "web" }] },
  ],
  tasks: {
    "FERN-101": "Cache every opened note in IndexedDB so it loads with no connection.",
    "FERN-102": "Queue edits made while offline and keep them across reloads.",
    "FERN-103": "Replay the queued edits on the sync API when the client reconnects.",
  },
  prTitle: "Cache notes in IndexedDB",
  doneReply: "PR #42 is open: notes are cached in IndexedDB and load offline.",
  ciReply: "CI is green on #42. It's ready for your review and merge.",
  mergedNote: "Your PR was merged. Wrap up this ticket.",
  mergedReply: "Merged. Cleaning up the branch.",
  testCommand: "pnpm test offline-queue",
  syncTestCommand: "pnpm test replay",
  question: "Two devices edited the same note offline. Should the later edit win, or keep both copies?",
  options: ["Later edit wins", "Keep both copies"],
  askedSay: "I need your call on conflicting edits before I write the replay step.",
  captions: {
    describe: "Describe the epic to its coordinator",
    split: "It splits the work into features and tickets",
    sessions: "Each ticket gets its own Claude Code session and worktree",
    yourTurn: "Shipherd only pings you when it's your turn",
    merge: "Merging stays with you",
    merged: "Merged. On to the next ticket",
  },
};

const ZH: DemoData = {
  epic: "离线模式",
  description: "没网的时候也能继续写笔记，联网以后把改动全部同步上去。",
  coordinatorBanner: "epic 总控 · 离线模式",
  coordinatorReply: "收到。我拆成 3 个 feature、5 个 ticket，先并行开工前三个。",
  features: [
    { name: "本地存储", tickets: [
      { key: "FERN-101", title: "笔记缓存进 IndexedDB", repo: "web" },
      { key: "FERN-102", title: "离线时把改动排队", repo: "web" },
    ] },
    { name: "同步", tickets: [
      { key: "FERN-103", title: "重新联网后回放改动", repo: "sync-api" },
      { key: "FERN-104", title: "冲突提示条", repo: "web" },
    ] },
    { name: "收尾", tickets: [{ key: "FERN-105", title: "工具栏的离线标记", repo: "web" }] },
  ],
  tasks: {
    "FERN-101": "打开过的笔记都缓存进 IndexedDB，没网也能打开。",
    "FERN-102": "离线时的改动排进队列，刷新页面也不丢。",
    "FERN-103": "客户端重新联网时，在同步 API 上回放排队的改动。",
  },
  prTitle: "笔记缓存进 IndexedDB",
  doneReply: "PR #42 开好了：笔记缓存进 IndexedDB，没网也能打开。",
  ciReply: "#42 的 CI 过了，等你 review 和合并。",
  mergedNote: "你的 PR 合进去了，把这个 ticket 收个尾。",
  mergedReply: "合进去了，正在清理分支。",
  testCommand: "pnpm test offline-queue",
  syncTestCommand: "pnpm test replay",
  question: "两台设备离线时改了同一篇笔记：后改的覆盖先改的，还是两份都留着？",
  options: ["后改的覆盖", "两份都留着"],
  askedSay: "冲突怎么处理要你拍板，定了我再写回放这一步。",
  captions: {
    describe: "把 epic 讲给它的总控",
    split: "总控拆成 feature 和 ticket",
    sessions: "每个 ticket 一个 Claude Code session、一个 worktree",
    yourTurn: "轮到你的时候 Shipherd 才叫你",
    merge: "合并由你来点",
    merged: "合进去了，接着做下一个",
  },
};

export const DEMO: Record<DemoLang, DemoData> = { en: EN, zh: ZH };

export const allTickets = (d: DemoData): (DemoTicket & { feature: string })[] =>
  d.features.flatMap((f) => f.tickets.map((t) => ({ ...t, feature: f.name })));

/** 假 claude 的剧本（FAKE_CLAUDE_SCRIPT，见 e2e/fake-claude/fake-claude.cjs 开头）。 */
export function fakeClaudeScript(d: DemoData): object {
  const read = (file: string) => `/fake-tool Read ${JSON.stringify({ file_path: file })}`;
  const grep = (pattern: string) => `/fake-tool Grep ${JSON.stringify({ pattern })}`;
  const edit = (file: string) => `/fake-tool Edit ${JSON.stringify({ file_path: file, old_string: "", new_string: "" })}`;
  return {
    banner: d.coordinatorBanner,
    rules: [
      // 总控：回一句，然后接着在看各 session（一直算在干活）。
      { when: d.description, reply: d.coordinatorReply, then: [{ after: 1200, line: "/fake-tool mcp__shipherd-sessions__list_sessions {}" }] },
      { when: d.tasks[PR_TICKET], reply: d.doneReply },
      { when: d.mergedNote, reply: d.mergedReply },
      { when: `#${PR_NUMBER}`, reply: d.ciReply },
      { when: d.tasks[WORKING_TICKET], then: [
        { after: 300, line: read("src/storage/notes-db.ts") },
        { after: 1100, line: edit("src/storage/edit-queue.ts") },
        { after: 2000, line: `/fake-bash ${d.testCommand}` },
      ] },
      { when: d.tasks[ASKING_TICKET], then: [
        { after: 300, line: read("src/sync/replay.ts") },
        { after: 900, line: grep("updatedAt") },
        { after: 1600, line: `/fake-mcp ask_user ${JSON.stringify({ question: d.question, options: d.options })}`, say: d.askedSay },
      ] },
      // 你的回答经信箱送回来：不停下，接着改代码、跑测试（一直算在干活）。
      { when: d.options[0], then: [
        { after: 300, line: edit("src/sync/replay.ts") },
        { after: 900, line: `/fake-bash ${d.syncTestCommand}` },
      ] },
    ],
  };
}
