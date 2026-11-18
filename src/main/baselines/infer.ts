// 第三层：确定性的两层找不到（或太少）时，让只读的 headless claude 看仓库补一份（设计 §3.5）。
// 结果逐条校验，只补确定性结果里没有的，标成 source=inferred、confidence=low。
import { z } from "zod";
import { headlessArgs } from "../claude/headless";
import type { HeadlessExecResult } from "../handoff/headless-exec";
import { toCliJsonSchema } from "../handoff/schema";
import { M } from "../strings";
import { BASELINE_CATEGORIES, REPO_STAGES, baselineCheckId, type BaselineCheck, type ProfileProject } from "../../shared/baselines";
import type { ScanOutput } from "./scan";

export type InferRunner = (req: { task: "repo_scan_infer"; label: string; args: string[]; prompt: string; cwd: string }) => Promise<HeadlessExecResult>;

const cmd = z.string().max(500);
const InferCheck = z.object({
  dir: z.string().max(300),
  category: z.enum(BASELINE_CATEGORIES),
  tool: z.string().min(1).max(60),
  command: cmd.min(1),
  fileCommand: cmd.optional(),
  changedFiles: z.boolean().optional(),
  stages: z.array(z.enum(REPO_STAGES)).max(3).optional(),
  evidence: z.string().max(300).optional(),
});
const PROFILE_FIELDS = ["install", "build", "testAll", "testOne", "fastest", "lint", "typecheck"] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];
const InferProfile = z.object({
  dir: z.string().max(300),
  install: cmd.nullable().optional(),
  build: cmd.nullable().optional(),
  testAll: cmd.nullable().optional(),
  testOne: cmd.nullable().optional(),
  fastest: cmd.nullable().optional(),
  lint: cmd.nullable().optional(),
  typecheck: cmd.nullable().optional(),
});

/** 给 --json-schema 的形状（字段都列全，结构化输出更稳）。 */
export const InferSchema = z.object({
  inferred_checks: z.array(InferCheck).max(40),
  profiles: z.array(InferProfile).max(20),
  notes: z.string().max(2000),
});
export const INFER_JSON_SCHEMA = toCliJsonSchema(InferSchema);
const INFER_TOOLS = ["Read", "Grep", "Glob"];

export type InferAnswer = z.infer<typeof InferSchema>;

/** 命令里不能有换行和 NUL；去掉首尾空白。 */
function cleanCommand(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t || /[\r\n\0]/.test(t)) return null;
  return t;
}

const normDir = (d: string) => d.replace(/\\/g, "/").replace(/^\.\/?/, "").replace(/\/+$/, "");

/** 目录要在文件列表里真的存在（"" 是根）。 */
function dirExists(files: string[], dir: string): boolean {
  return dir === "" || files.some((f) => f.startsWith(`${dir}/`));
}

/**
 * 把模型的回答并进确定性结果：逐条校验（坏的那条丢掉，不连累别的），只补「同目录同类别」没有的检查、档案里还空着的字段。
 * 返回新的结果和丢掉了几条。
 */
export function mergeInferred(out: ScanOutput, raw: unknown, files: string[]): { out: ScanOutput; added: number; dropped: number } {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const rawChecks = Array.isArray(obj.inferred_checks) ? obj.inferred_checks.slice(0, 40) : [];
  const rawProfiles = Array.isArray(obj.profiles) ? obj.profiles.slice(0, 20) : [];
  let dropped = 0;
  const checks: BaselineCheck[] = [...out.checks];
  let added = 0;
  for (const rc of rawChecks) {
    const p = InferCheck.safeParse(rc);
    if (!p.success) {
      dropped++;
      continue;
    }
    const c = p.data;
    const dir = normDir(c.dir);
    const command = cleanCommand(c.command);
    if (!command || !dirExists(files, dir)) {
      dropped++;
      continue;
    }
    if (checks.some((x) => x.dir === dir && x.category === c.category)) continue;
    const fileCommand = cleanCommand(c.fileCommand) ?? undefined;
    const tool = c.tool.trim().replace(/\s+/g, "-").toLowerCase();
    checks.push({
      id: baselineCheckId(dir, c.category, tool), dir, category: c.category, tool, command, fileCommand: fileCommand && fileCommand.includes("{file}") ? fileCommand : undefined,
      stages: [...new Set(c.stages ?? [])], changedFiles: !!c.changedFiles || !!(fileCommand && fileCommand.includes("{file}")),
      butlerStage: fileCommand?.includes("{file}") && (c.category === "lint" || c.category === "format" || c.category === "typecheck") ? "edit" : "push",
      source: "inferred", confidence: "low", evidence: [c.evidence?.trim() || "inferred"], facts: [],
    });
    added++;
  }
  const projects: ProfileProject[] = out.profile.projects.map((p) => ({ ...p, inferred: [...p.inferred] }));
  for (const rp of rawProfiles) {
    const p = InferProfile.safeParse(rp);
    if (!p.success) {
      dropped++;
      continue;
    }
    const dir = normDir(p.data.dir);
    if (!dirExists(files, dir)) {
      dropped++;
      continue;
    }
    let target = projects.find((x) => x.dir === dir);
    if (!target) {
      target = { dir, langs: [], install: null, build: null, testAll: null, testOne: null, fastest: null, lint: null, typecheck: null, inferred: [] };
      projects.push(target);
    }
    for (const f of PROFILE_FIELDS) {
      const v = cleanCommand(p.data[f]);
      if (!v || target[f as ProfileField] !== null) continue;
      target[f as ProfileField] = v;
      if (!target.inferred.includes(f)) target.inferred.push(f);
    }
  }
  projects.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  checks.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return { out: { ...out, checks, profile: { ...out.profile, projects } }, added, dropped };
}

/** 给模型看的：确定性结果的摘要、为什么问它、CI 里认不出的命令、文件列表的一部分。 */
export function inferPrompt(slug: string, out: ScanOutput, files: string[]): string {
  const found = out.checks.length
    ? out.checks.map((c) => `- ${c.dir || "."} ${c.category} ${c.tool}: ${c.command}`).join("\n")
    : "-";
  const projects = out.projects.length ? out.projects.map((p) => `- ${p.dir || "."} (${p.langs.join(", ") || "?"})`).join("\n") : "-";
  const ci = out.unclassified.length ? out.unclassified.map((u) => `- ${u.dir || "."}: ${u.command} (${u.evidence})`).join("\n") : "-";
  const sample = files.slice(0, 150).join("\n");
  return M().baselines.inferPrompt({ slug, reasons: out.inferReasons, projects, found, ci, sample, more: Math.max(0, files.length - 150) });
}

export type InferOutcome =
  | { state: "ran"; out: ScanOutput; detail: string }
  | { state: "failed"; out: ScanOutput; detail: string };

/** 跑一次模型补全。失败（没装 claude、额度、坏输出）都保留确定性结果。 */
export async function runInference(run: InferRunner, o: { slug: string; root: string; out: ScanOutput; files: string[]; signal?: AbortSignal }): Promise<InferOutcome> {
  let r: HeadlessExecResult;
  try {
    r = await run({
      task: "repo_scan_infer", label: "repo scan", args: headlessArgs({ schema: INFER_JSON_SCHEMA, allowedTools: INFER_TOOLS }), prompt: inferPrompt(o.slug, o.out, o.files), cwd: o.root,
    });
  } catch (e) {
    return { state: "failed", out: o.out, detail: String(e instanceof Error ? e.message : e).slice(0, 500) };
  }
  if (!r.ok) return { state: "failed", out: o.out, detail: `${r.reason}: ${r.message}`.slice(0, 500) };
  const m = mergeInferred(o.out, r.value, o.files);
  const notes = typeof (r.value as { notes?: unknown } | null)?.notes === "string" ? String((r.value as { notes: string }).notes).slice(0, 300) : "";
  return { state: "ran", out: m.out, detail: [`+${m.added}`, m.dropped ? `-${m.dropped}` : "", notes].filter(Boolean).join(" · ") };
}
