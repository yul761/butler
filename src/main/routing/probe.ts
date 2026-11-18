import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { headlessArgs } from "../claude/headless";
import { execHeadlessJson, type HeadlessExecDeps } from "../handoff/headless-exec";
import type { ProbeOutcome } from "./routing-service";

export const MODEL_PROBE_TIMEOUT_MS = 60_000;
/** 模型发现看最近多久的用量。 */
export const DISCOVERY_USAGE_WINDOW_MS = 30 * 86_400_000;
const PROBE_SCHEMA = JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false });
const PROBE_PROMPT = 'Reply with {"ok": true} and nothing else.';

/** 用这个模型发一次最便宜的调用：没有工具、不留 session，在临时目录里跑。 */
export async function probeWithHeadless(d: HeadlessExecDeps, model: string, cwd: string = tmpdir()): Promise<ProbeOutcome> {
  const r = await execHeadlessJson(d, {
    task: "model_probe", label: "model probe", args: headlessArgs({ schema: PROBE_SCHEMA, allowedTools: [] }), prompt: PROBE_PROMPT, cwd, forceModel: model,
  });
  if (r.ok) return { ok: true };
  return { ok: false, hit: r.limit ? { kind: r.limit.kind, resetsAt: r.limit.resetsAt, message: r.limit.message } : null, message: r.message };
}

/** ~/.claude/settings.json 里的 model；没有或读不了为 null。 */
export async function readClaudeSettingsModel(file: string): Promise<string | null> {
  try {
    const v = JSON.parse(await readFile(file, "utf8")) as unknown;
    const m = typeof v === "object" && v !== null ? (v as Record<string, unknown>).model : undefined;
    return typeof m === "string" ? m : null;
  } catch {
    return null;
  }
}
