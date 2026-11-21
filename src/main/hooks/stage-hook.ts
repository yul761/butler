// hook 信封 → PR 进度的 skill 事件：PostToolUse 的 Skill 工具调用，或者 UserPromptSubmit 里的 /skill。
import { isHeadlessEnvelope, type HookEnvelope } from "../../shared/hook-envelope";
import { skillCategory, slashSkill } from "../../shared/pr-stages";
import type { Session } from "../../shared/types";
import type { SessionsRepo } from "../db/sessions-repo";
import type { Observation } from "../prwatch/pr-observe";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** skill 名：Skill 工具的 tool_input.skill，/skill 提示的 skill 名，或者 review agent 的 `agent:<描述>`。 */
function skillName(p: Record<string, unknown>): string | null {
  const event = str(p.hook_event_name);
  if (event === "PostToolUse" && (p.tool_name === "Agent" || p.tool_name === "Task")) {
    const input = p.tool_input && typeof p.tool_input === "object" ? (p.tool_input as Record<string, unknown>) : {};
    const description = str(input.description);
    const subagentType = str(input.subagent_type);
    // 只有描述或类型里带 review 的子 agent 才算：别的子 agent 不是 PR 进度。
    return /\breview/i.test(`${description ?? ""} ${subagentType ?? ""}`) ? `agent:${description ?? subagentType}` : null;
  }
  if (event === "PostToolUse" && p.tool_name === "Skill") {
    const input = p.tool_input && typeof p.tool_input === "object" ? (p.tool_input as Record<string, unknown>) : {};
    return str(input.skill);
  }
  if (event === "UserPromptSubmit") return typeof p.prompt === "string" ? slashSkill(p.prompt) : null;
  return null;
}

type Owner = { ticketKey: string | null; repoId: number | null; featureId: number | null };

/** 事件归到哪一层：ticket（加仓库）、feature；归不了为 null。 */
function ownerOf(s: Session, sessions: Pick<SessionsRepo, "get">): Owner | null {
  if (s.butler) return null;
  if (s.fixesSession) {
    // 修复 session 的工作算在被修的那个 session 上。
    const t = sessions.get(s.fixesSession);
    if (!t || t.butler) return null;
    if (t.ticketKey) return { ticketKey: t.ticketKey, repoId: t.repoId, featureId: null };
    if (t.featureId !== null) return { ticketKey: null, repoId: null, featureId: t.featureId };
    return null;
  }
  if (s.ticketKey) return { ticketKey: s.ticketKey, repoId: s.repoId, featureId: null };
  if (s.featureId !== null) return { ticketKey: null, repoId: null, featureId: s.featureId };
  return null;
}

/** PostToolUse 且 tool_name=Skill（tool_input.skill）或 review 类的 Agent/Task，或者 UserPromptSubmit 且 prompt 是 /skill；归不了类、归不到 ticket/feature、headless 的 → null。 */
export function stageEventFromHook(env: HookEnvelope, sessions: Pick<SessionsRepo, "get">): Observation | null {
  if (isHeadlessEnvelope(env)) return null;
  const p = env.payload && typeof env.payload === "object" ? (env.payload as Record<string, unknown>) : {};
  const sessionId = str(p.session_id);
  const name = skillName(p);
  if (!sessionId || !name) return null;
  const category = skillCategory(name);
  if (!category) return null;
  const s = sessions.get(sessionId);
  if (!s) return null;
  const owner = ownerOf(s, sessions);
  if (!owner) return null;
  // PostToolUse 按 tool_use_id 去重（receivedAt 每次 hook 都不同）；没有就退回 receivedAt。
  const toolUseId = str(p.tool_use_id);
  const key = str(p.hook_event_name) === "PostToolUse" && toolUseId ? `skill:${sessionId}:${toolUseId}` : `skill:${sessionId}:${env.receivedAt}:${name}`;
  return {
    event: { ...owner, prId: null, branch: s.gitBranch ?? null, sessionId, kind: "skill", at: env.receivedAt, data: { name, category } },
    dedupeKey: key,
  };
}
