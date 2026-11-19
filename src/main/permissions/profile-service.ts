import { z } from "zod";
import type { ProfileCandidate, ProfileRule, ProfileScan } from "../../shared/interrupts";
import { headlessArgs } from "../claude/headless";
import type { PermissionProfileRepo } from "../db/interrupts-repo";
import { execHeadlessJson, type HeadlessExecDeps } from "../handoff/headless-exec";
import { toCliJsonSchema, validate } from "../handoff/schema";
import { currentLang } from "../i18n";
import { SettingError } from "../settings/settings-values";
import { M } from "../strings";
import { isSafeRule, matchesRule } from "./classify";
import { scanTranscripts, type ScanCandidate } from "./scan";

const SLUG = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
/** 一次请模型解释最多给多少个候选。 */
const EXPLAIN_MAX = 60;

const ExplainSchema = z.object({ items: z.array(z.object({ rule: z.string(), why: z.string(), caution: z.boolean() })) });
const EXPLAIN_JSON_SCHEMA = toCliJsonSchema(ExplainSchema);

export interface ProfileServiceDeps {
  repo: PermissionProfileRepo;
  /** Claude Code 的 projects 目录（<config>/projects）。 */
  projectsDir: string;
  slugOf(path: string): string | null;
  /** 路由（契约 4.1）；不给就不能解释。 */
  exec?: HeadlessExecDeps;
  /** 解释时 claude 在哪个目录跑（不碰仓库）。 */
  workDir(): string;
  setting(key: "permissionProfiles"): string;
  now(): number;
  /** 有规则确认了：Effect 页前后对比的分界（只第一次生效）。 */
  markEffective(at: number): void;
  log?(msg: string, err?: unknown): void;
}

/**
 * 权限档案（ws-j 设计 2）：从历史里算候选，用户确认一次，确认的规则写进这个仓库的 session 的 --settings。
 * 每一条进出都过 isSafeRule：存、用、导入都一样，写操作永远放不进去。
 */
export class PermissionProfileService {
  private last: { at: number; candidates: ProfileCandidate[] } | null = null;
  private scanning: Promise<ProfileScan> | null = null;

  constructor(private readonly d: ProfileServiceDeps) {}

  /** 存下来的所有决定（设置页的列表）。 */
  rules(): ProfileRule[] {
    return this.d.repo.all();
  }

  /** 上一次扫描的结果（去掉已经决定的），加上导入进来等确认的规则。 */
  state(): ProfileScan {
    return { scannedAt: this.last?.at ?? null, candidates: this.undecided(this.last?.candidates ?? []), pending: this.d.repo.all().filter((r) => r.status === "pending") };
  }

  /** 重新读 transcript。同时只扫一遍。 */
  scan(): Promise<ProfileScan> {
    this.scanning ??= (async () => {
      try {
        const now = this.d.now();
        const found = await scanTranscripts({ projectsDir: this.d.projectsDir, slugOf: (p) => this.d.slugOf(p), now });
        const prior = new Map((this.last?.candidates ?? []).map((c) => [`${c.slug}\n${c.rule}`, c]));
        this.last = {
          at: now,
          candidates: found.filter((c) => isSafeRule(c.rule)).map((c: ScanCandidate) => {
            const p = prior.get(`${c.slug}\n${c.rule}`);
            return { ...c, why: p?.why ?? null, caution: p?.caution ?? false };
          }),
        };
      } catch (e) {
        this.d.log?.("permission profile: scanning the transcripts failed", e);
      }
      return this.state();
    })().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private undecided(cs: ProfileCandidate[]): ProfileCandidate[] {
    const decided = new Set(this.d.repo.all().filter((r) => r.status !== "pending").map((r) => `${r.slug}\n${r.rule}`));
    return cs.filter((c) => !decided.has(`${c.slug}\n${c.rule}`));
  }

  /** 用户在向导或设置页上确认：confirm 里的确认，dismiss 里的以后不再提。不安全的规则直接拒绝（整次不写）。 */
  decide(slug: string, confirm: readonly string[], dismiss: readonly string[]): ProfileRule[] {
    if (!SLUG.test(slug)) throw new SettingError(M().interrupts.badSlug);
    for (const r of [...confirm, ...dismiss]) if (!isSafeRule(r)) throw new SettingError(M().interrupts.unsafeRule(r));
    const now = this.d.now();
    const seen = new Map((this.last?.candidates ?? []).filter((c) => c.slug === slug).map((c) => [c.rule, c]));
    const sourceOf = (rule: string) => (seen.has(rule) ? "history" : this.d.repo.get(slug, rule)?.source ?? "manual");
    for (const rule of confirm) {
      const c = seen.get(rule);
      this.d.repo.set({ slug, rule, status: "confirmed", source: sourceOf(rule), runs: c?.runs ?? 0, sessions: c?.sessions ?? 0, at: now });
    }
    for (const rule of dismiss) {
      const c = seen.get(rule);
      this.d.repo.set({ slug, rule, status: "dismissed", source: sourceOf(rule), runs: c?.runs ?? 0, sessions: c?.sessions ?? 0, at: now });
    }
    if (confirm.length > 0) this.d.markEffective(now);
    return this.d.repo.bySlug(slug);
  }

  /** 删掉一条（确认过的或不再提的）：下次扫描又会出现在候选里。 */
  remove(slug: string, rule: string): boolean {
    return this.d.repo.remove(slug, rule);
  }

  /** 这些目录（session 的 cwd 和 ticket 的仓库）的 session 该放行的规则：开关关着、或者规则过不了检查的都不给。 */
  rulesForDirs(dirs: readonly string[]): string[] {
    if (this.d.setting("permissionProfiles").trim() !== "1") return [];
    const slugs = [...new Set(dirs.map((p) => this.slugSafe(p)).filter((s): s is string => s !== null))];
    return this.d.repo.confirmed(slugs).filter((r) => isSafeRule(r));
  }

  /** 这个目录的 session 的一次工具调用被档案放行了吗（返回放行它的规则）。 */
  matchFor(dir: string, call: { tool: string; command?: string }): string | null {
    return this.rulesForDirs([dir]).find((r) => matchesRule(r, call)) ?? null;
  }

  private slugSafe(p: string): string | null {
    try {
      return this.d.slugOf(p);
    } catch {
      return null;
    }
  }

  /** 请低档模型（task permission_profile）给每个候选写一句说明、标出要小心的；模型不能加规则。失败时原样返回。 */
  async explain(): Promise<ProfileScan> {
    const cs = this.state().candidates.slice(0, EXPLAIN_MAX);
    if (!this.d.exec || cs.length === 0 || !this.last) return this.state();
    const args = headlessArgs({ schema: EXPLAIN_JSON_SCHEMA, allowedTools: [] });
    const r = await execHeadlessJson(this.d.exec, { task: "permission_profile", label: "permission profile", args, prompt: explainPrompt(cs), cwd: this.d.workDir() });
    if (!r.ok) {
      this.d.log?.(`permission profile: explaining the candidates failed (${r.reason})`);
      return this.state();
    }
    const v = validate(ExplainSchema, r.value);
    if (!v.ok) return this.state();
    const notes = new Map(v.value.items.map((i) => [i.rule, i]));
    this.last = {
      ...this.last,
      candidates: this.last.candidates.map((c) => {
        const n = notes.get(c.rule);
        return n ? { ...c, why: n.why.slice(0, 200), caution: n.caution } : c;
      }),
    };
    return this.state();
  }
}

function explainPrompt(cs: readonly ProfileCandidate[]): string {
  const list = [...new Set(cs.map((c) => c.rule))].map((rule) => {
    const ex = cs.find((c) => c.rule === rule)?.example ?? "";
    return `- ${rule}  (e.g. ${ex})`;
  });
  if (currentLang() === "en") {
    return [
      "These Claude Code permission rules would let a coding session run the commands below without asking. A deterministic check already decided they are read-only.",
      "For each rule write one short sentence saying what it allows, and set caution to true if it could leak secrets, reach a different machine or account, or is otherwise worth a second look.",
      "Answer as JSON: items (rule exactly as given, why, caution). Do not add rules that are not in the list.",
      "",
      ...list,
    ].join("\n");
  }
  return [
    "下面这些 Claude Code 权限规则会让写代码的 session 不用确认就能跑对应的命令。确定性检查已经判定它们是只读的。",
    "每条写一句短话说明它放行了什么；如果它可能泄露密钥、连到别的机器或账号、或者别的原因值得再看一眼，caution 设为 true。",
    "用 JSON 回答：items（rule 原样照抄、why、caution）。不要加列表里没有的规则。",
    "",
    ...list,
  ].join("\n");
}
