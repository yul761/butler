import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renameWithRetrySync } from "../src/main/util/fs-retry";
import { CONTROL_VERSION, MAX_CREATE_REPOS, TASK_LIMIT, type ControlRequest, type ControlResult } from "../src/shared/control";
import type { Lang } from "../src/shared/i18n";

/**
 * butler-sessions：只挂给总控 session 的 MCP server（设计文档 2026-10-23 第二步）。stdio 上按行收发 JSON-RPC 2.0；
 * 工具调用写成请求文件交给 Butler，等结果文件。不开端口，也不调用任何模型。
 */

export interface SessionsServerOptions {
  /** 这个总控管哪个 ticket（或哪个 feature，设计文档 2026-10-26）：来自 Butler 写的 mcp 配置，不来自模型。 */
  scope: { ticketKey: string } | { featureId: number };
  /** 工具描述和错误用哪种语言（Butler 写进 mcp 配置的 BUTLER_LANG；设计文档 2026-10-26）。默认中文。 */
  lang?: Lang;
  /** 总控自己的 session id（claude 传下来的 BUTLER_SESSION），子 session 记成由它开启。 */
  from: string | null;
  requestsDir: string;
  resultsDir: string;
  timeoutMs?: number;
  pollMs?: number;
  version?: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const SERVER_NAME = "butler-sessions";
const DEFAULT_PROTOCOL = "2025-06-18";

export const TOOLS = [
  {
    name: "list_repos",
    description: "列出这个 ticket 的仓库（名字、工作目录、分支）。start_session 的 repo 参数用这里的名字。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "start_session",
    description:
      "在这个 ticket 的某个仓库里新开一个 Claude Code session，把 task 当作第一条消息发给它。新 session 会出现在 Butler 的同一个 ticket 下面，" +
      "用户可以看到、接手，权限确认仍由用户处理。各个 session 共享这个 ticket 的记忆：要交代的背景和约定先写进记忆。返回新 session 的 id。",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "仓库名（list_repos 里的 name）或工作目录" },
        task: { type: "string", description: `交给新 session 的任务，最长 ${TASK_LIMIT} 字` },
      },
      required: ["repo", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "list_sessions",
    description: "列出这个 ticket 的 session：在哪个仓库、第一句话、是否在运行、是否在等用户输入、最近活动时间、是否由总控开启。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

/** feature 总控的工具（设计文档 2026-10-26）。 */
export const FEATURE_TOOLS = [
  {
    name: "list_tickets",
    description: "列出这个 feature 下的 ticket：ticket 号、标题、状态，以及每个 ticket 的仓库（名字、工作目录、分支）。每个 ticket 有自己的分支和 worktree。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_repos",
    description: "列出这个 feature 的仓库（名字、路径）。create_ticket 的 repos 参数用这里的名字。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_ticket",
    description:
      "在这个 feature 下新建一个 ticket：在选中的仓库里各建一个分支和 worktree（放在 feature 工作区里），ticket 马上出现在 Butler 里这个 feature 下面。" +
      "先和用户讨论好这个 feature 要拆成哪些 ticket、每个 ticket 做什么，再逐个建；建好后用 start_session 在 ticket 里开 session 交代任务。" +
      "ticket 号必须符合 Butler 设置里的格式（默认像 PROJ-123）；有 Jira 号就用 Jira 号。返回 ticket 的仓库、工作目录和分支。",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string", description: "ticket 号，例如 PROJ-123" },
        title: { type: "string", description: "标题（可选）" },
        repos: { type: "array", items: { type: "string" }, maxItems: MAX_CREATE_REPOS, description: "这个 ticket 用到的仓库名（list_repos 里的 name）；feature 只有一个仓库时可以省略" },
        branch: { type: "string", description: "分支名（可选，默认按 Butler 设置里的分支模板生成）" },
      },
      required: ["ticket"],
      additionalProperties: false,
    },
  },
  {
    name: "start_session",
    description:
      "为这个 feature 下的某个 ticket 新开一个 Claude Code session，在那个 ticket 的仓库（worktree）里工作，把 task 当作第一条消息发给它。" +
      "新 session 出现在 Butler 里那个 ticket 下面，用户可以看到、接手，权限确认仍由用户处理。" +
      "前后端之间的接口约定、共同的背景先写进 feature 记忆（butler-feature），每个 ticket 的 session 都能读到。返回新 session 的 id。",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string", description: "ticket 号（list_tickets 里的 key）" },
        repo: { type: "string", description: "仓库名或工作目录；ticket 只有一个仓库时可以省略" },
        task: { type: "string", description: `交给新 session 的任务，最长 ${TASK_LIMIT} 字` },
      },
      required: ["ticket", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "list_sessions",
    description: "列出这个 feature 的 session（feature 总控和每个 ticket 的）：属于哪个 ticket、哪个仓库、第一句话、是否在运行、是否在等用户输入、最近活动时间、是否由总控开启。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

/** 英文版：工具名、参数和 schema 一样，只有描述不同。 */
export const TOOLS_EN = [
  {
    ...TOOLS[0],
    description: "List this ticket's repos (name, working folder, branch). Use these names for start_session's repo argument.",
  },
  {
    ...TOOLS[1],
    description:
      "Open a new Claude Code session in one of this ticket's repos and send it task as its first message. The new session appears under the same ticket in Butler, " +
      "where the user can watch it and take over; the user still answers its permission prompts. All sessions share this ticket's memory: write the background and agreements to memory first. Returns the new session's id.",
    inputSchema: {
      ...TOOLS[1].inputSchema,
      properties: {
        repo: { type: "string", description: "repo name (name in list_repos) or working folder" },
        task: { type: "string", description: `the task for the new session, at most ${TASK_LIMIT} characters` },
      },
    },
  },
  {
    ...TOOLS[2],
    description: "List this ticket's sessions: repo, first message, whether it is running, whether it waits for the user, last activity, and whether the coordinator started it.",
  },
] as const;

export const FEATURE_TOOLS_EN = [
  {
    ...FEATURE_TOOLS[0],
    description: "List this feature's tickets: id, title, status, and each ticket's repos (name, working folder, branch). Every ticket has its own branch and worktree.",
  },
  {
    ...FEATURE_TOOLS[1],
    description: "List this feature's repos (name, path). Use these names for create_ticket's repos argument.",
  },
  {
    ...FEATURE_TOOLS[2],
    description:
      "Create a ticket in this feature: a branch and a worktree in each chosen repo (inside the feature's workspace). The ticket appears under this feature in Butler right away. " +
      "First agree with the user which tickets the feature splits into and what each one does, then create them one by one; afterwards use start_session to open a session in each ticket and hand it its task. " +
      "The ticket id must match the format in Butler's settings (by default like PROJ-123); use the Jira id if there is one. Returns the ticket's repos, working folders and branches.",
    inputSchema: {
      ...FEATURE_TOOLS[2].inputSchema,
      properties: {
        ticket: { type: "string", description: "the ticket id, for example PROJ-123" },
        title: { type: "string", description: "a title (optional)" },
        repos: { type: "array", items: { type: "string" }, maxItems: MAX_CREATE_REPOS, description: "the repos this ticket uses (name in list_repos); may be left out when the feature has one repo" },
        branch: { type: "string", description: "the branch name (optional; by default made from the branch template in Butler's settings)" },
      },
    },
  },
  {
    ...FEATURE_TOOLS[3],
    description:
      "Open a new Claude Code session for one of this feature's tickets, working in that ticket's repo (worktree), and send it task as its first message. " +
      "The new session appears under that ticket in Butler, where the user can watch it and take over; the user still answers its permission prompts. " +
      "Write the API contract between frontend and backend and any shared background to the feature memory (butler-feature) first; every ticket's sessions can read it. Returns the new session's id.",
    inputSchema: {
      ...FEATURE_TOOLS[3].inputSchema,
      properties: {
        ticket: { type: "string", description: "the ticket id (key in list_tickets)" },
        repo: { type: "string", description: "repo name or working folder; may be left out when the ticket has one repo" },
        task: { type: "string", description: `the task for the new session, at most ${TASK_LIMIT} characters` },
      },
    },
  },
  {
    ...FEATURE_TOOLS[4],
    description: "List this feature's sessions (the feature coordinator's and every ticket's): ticket, repo, first message, whether it is running, whether it waits for the user, last activity, and whether the coordinator started it.",
  },
] as const;

const TEXT = {
  zh: {
    noReplyStart: "Butler 没有及时回应（可能没在运行）。session 也可能已经开了：重试之前先用 list_sessions 看一下。",
    noReply: "Butler 没有回应（Butler 没在运行？）",
    noReplyCreate: "Butler 没有及时回应（可能没在运行，或者还在建 worktree）。ticket 也可能已经建好：重试之前先用 list_tickets 看一下。",
    needTicket: "create_ticket 需要字符串参数 ticket",
    badCreateArgs: `title、branch 必须是字符串，repos 必须是最多 ${MAX_CREATE_REPOS} 个字符串的数组`,
    needRepoTask: "start_session 需要 repo 和 task 两个字符串参数",
    needTicketTask: "start_session 需要 ticket 和 task 两个字符串参数",
    repoString: "repo 必须是字符串",
    taskTooLong: `task 太长（最多 ${TASK_LIMIT} 字）`,
    noTool: (t: string) => `没有这个工具：${t}`,
  },
  en: {
    noReplyStart: "Butler did not answer in time (it may not be running). The session may already be open: check with list_sessions before retrying.",
    noReply: "Butler did not answer (is Butler running?)",
    noReplyCreate: "Butler did not answer in time (it may not be running, or it is still creating worktrees). The ticket may already exist: check with list_tickets before retrying.",
    needTicket: "create_ticket needs a string argument, ticket",
    badCreateArgs: `title and branch must be strings, and repos an array of at most ${MAX_CREATE_REPOS} strings`,
    needRepoTask: "start_session needs two string arguments, repo and task",
    needTicketTask: "start_session needs two string arguments, ticket and task",
    repoString: "repo must be a string",
    taskTooLong: `task is too long (at most ${TASK_LIMIT} characters)`,
    noTool: (t: string) => `No such tool: ${t}`,
  },
};

/** create_ticket 等结果的时间是平常的几倍（要建 worktree）。 */
const CREATE_WAIT_FACTOR = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SessionsServer {
  /** 写出去、还没等到结果的请求文件。 */
  private readonly pending = new Set<string>();

  private readonly en: boolean;
  private readonly text: (typeof TEXT)["zh"];

  constructor(private readonly o: SessionsServerOptions) {
    this.en = o.lang === "en";
    this.text = TEXT[this.en ? "en" : "zh"];
  }

  /** 退出前撤回还没被 Butler 拿走的请求：没人等结果了，不该再去开 session。 */
  withdrawAll(): void {
    for (const f of this.pending) {
      try {
        unlinkSync(f);
      } catch {
        // Butler 已经拿走了。
      }
    }
    this.pending.clear();
  }

  /** 处理一条消息；通知（没有 id）返回 null。 */
  async handle(msg: JsonRpcMessage): Promise<object | null> {
    const id = msg.id;
    const isRequest = id !== undefined && id !== null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: isRequest ? id : null, error: { code, message } });
    switch (msg.method) {
      case "initialize": {
        const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : DEFAULT_PROTOCOL;
        return reply({ protocolVersion: asked, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: this.o.version ?? "1" } });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: "featureId" in this.o.scope ? (this.en ? FEATURE_TOOLS_EN : FEATURE_TOOLS) : this.en ? TOOLS_EN : TOOLS });
      case "tools/call":
        return reply(await this.call(msg.params ?? {}));
      default:
        if (!isRequest) return null;
        return fail(-32601, `method not found: ${String(msg.method)}`);
    }
  }

  private async call(params: Record<string, unknown>): Promise<object> {
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const req = "featureId" in this.o.scope ? this.featureRequest(this.o.scope.featureId, params.name, args) : this.ticketRequest(this.o.scope.ticketKey, params.name, args);
    if ("content" in req) return req;
    // 建 ticket 要建 worktree（大仓库在 Windows 上可能要一会儿）：多等一些。
    const result = await this.send(req, req.op === "create_ticket" ? CREATE_WAIT_FACTOR : 1);
    if (!result) {
      return toolError(
        req.op === "start_session"
          ? this.text.noReplyStart
          : req.op === "create_ticket"
            ? this.text.noReplyCreate
            : this.text.noReply,
      );
    }
    if (!result.ok) return toolError(result.error);
    return { content: [{ type: "text", text: JSON.stringify(result.value, null, 2) }] };
  }

  private ticketRequest(ticketKey: string, tool: unknown, args: Record<string, unknown>): ControlRequest | ToolError {
    const base = { v: CONTROL_VERSION, ticketKey, from: this.o.from } as const;
    switch (tool) {
      case "list_repos":
        return { ...base, op: "list_repos" };
      case "list_sessions":
        return { ...base, op: "list_sessions" };
      case "start_session":
        if (typeof args.repo !== "string" || typeof args.task !== "string") return toolError(this.text.needRepoTask);
        if (args.task.length > TASK_LIMIT) return toolError(this.text.taskTooLong);
        return { ...base, op: "start_session", repo: args.repo, task: args.task };
      default:
        return toolError(this.text.noTool(String(tool)));
    }
  }

  private featureRequest(featureId: number, tool: unknown, args: Record<string, unknown>): ControlRequest | ToolError {
    const base = { v: CONTROL_VERSION, featureId, from: this.o.from } as const;
    switch (tool) {
      case "list_tickets":
        return { ...base, op: "list_tickets" };
      case "list_repos":
        return { ...base, op: "list_repos" };
      case "list_sessions":
        return { ...base, op: "list_sessions" };
      case "create_ticket": {
        if (typeof args.ticket !== "string") return toolError(this.text.needTicket);
        const { title, repos, branch } = args;
        const okRepos = repos === undefined || (Array.isArray(repos) && repos.length <= MAX_CREATE_REPOS && repos.every((r) => typeof r === "string"));
        if ((title !== undefined && typeof title !== "string") || (branch !== undefined && typeof branch !== "string") || !okRepos) {
          return toolError(this.text.badCreateArgs);
        }
        return {
          ...base, op: "create_ticket", ticket: args.ticket,
          ...(typeof title === "string" && { title }),
          ...(Array.isArray(repos) && { repos: repos as string[] }),
          ...(typeof branch === "string" && branch.trim() && { branch: branch.trim() }),
        };
      }
      case "start_session":
        if (typeof args.ticket !== "string" || typeof args.task !== "string") return toolError(this.text.needTicketTask);
        if (args.repo !== undefined && typeof args.repo !== "string") return toolError(this.text.repoString);
        if (args.task.length > TASK_LIMIT) return toolError(this.text.taskTooLong);
        return { ...base, op: "start_session", ticket: args.ticket, ...(typeof args.repo === "string" && { repo: args.repo }), task: args.task };
      default:
        return toolError(this.text.noTool(String(tool)));
    }
  }

  /** 写请求文件（临时文件 + rename），等同名的结果文件。超时返回 null，并撤回还没被处理的请求。 */
  async send(req: ControlRequest, waitFactor = 1): Promise<ControlResult | null> {
    const id = randomUUID();
    mkdirSync(this.o.requestsDir, { recursive: true });
    const file = join(this.o.requestsDir, `${id}.json`);
    const tmp = join(this.o.requestsDir, `${id}.tmp`);
    writeFileSync(tmp, JSON.stringify(req), { mode: 0o600 });
    renameWithRetrySync(tmp, file);
    this.pending.add(file);
    try {
      const resultFile = join(this.o.resultsDir, `${id}.json`);
      const end = Date.now() + (this.o.timeoutMs ?? 60_000) * waitFactor;
      while (Date.now() < end) {
        if (existsSync(resultFile)) {
          let r: ControlResult | null = null;
          try {
            r = JSON.parse(readFileSync(resultFile, "utf8")) as ControlResult;
          } catch {
            // 结果文件还没写完（rename 之前不会出现，这里只是兜底）。
          }
          if (r) {
            try {
              unlinkSync(resultFile);
            } catch {
              // Windows 上可能被短暂占用：结果已经读到了，留下的文件由 Butler 定期清理。
            }
            return r;
          }
        }
        await sleep(this.o.pollMs ?? 200);
      }
      try {
        unlinkSync(file);
      } catch {
        // Butler 已经拿走了请求。
      }
      return null;
    } finally {
      this.pending.delete(file);
    }
  }
}

interface ToolError {
  content: { type: "text"; text: string }[];
  isError: true;
}

function toolError(text: string): ToolError {
  return { content: [{ type: "text", text }], isError: true };
}

/** stdio：每行一条 JSON-RPC 消息，回复也是一行一条。 */
export function serveStdio(server: SessionsServer, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): void {
  let buf = "";
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
        continue;
      }
      void server.handle(msg).then(
        (r) => r && output.write(`${JSON.stringify(r)}\n`),
        (e: unknown) => output.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: String(e) } })}\n`),
      );
    }
  });
}
