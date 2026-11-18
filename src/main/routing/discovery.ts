import { isModelName, type DiscoveredModel, type DiscoveryView, type Tier } from "../../shared/model-routing";
import type { ProbeOutcome } from "./routing-service";

/** Claude Code 认的模型相关环境变量（按这个顺序列出）。 */
export const MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;
/** CLI 的别名：不假设它们一定能用，一样要探测。 */
export const CLI_ALIASES = ["opus", "sonnet", "haiku"] as const;

const ENV_TIER: Partial<Record<string, Tier>> = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: "high",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "mid",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "low",
  ANTHROPIC_SMALL_FAST_MODEL: "low",
};

/** 按名字猜档位；猜不出为 null（让用户选）。 */
export function suggestTier(name: string, from?: string): Tier | null {
  const byEnv = from ? ENV_TIER[from] : undefined;
  if (byEnv) return byEnv;
  const n = name.toLowerCase();
  if (/opus|fable/.test(n)) return "high";
  if (/sonnet/.test(n)) return "mid";
  if (/haiku/.test(n)) return "low";
  return null;
}

export interface DiscoverySources {
  env: NodeJS.ProcessEnv;
  /** ~/.claude/settings.json 里的 model（读不了为 null）。 */
  settingsModel: () => Promise<string | null>;
  /** 最近用量里出现过的模型名（CLI 报的全名）。 */
  recentModels: () => string[];
  /** 已登记的模型：一起探测，找出配了但不存在的。 */
  registry: () => string[];
}

/** 要探测的候选：去重，先出现的来源算数。 */
export async function discoveryCandidates(s: DiscoverySources): Promise<{ name: string; from: string }[]> {
  const out: { name: string; from: string }[] = [];
  const seen = new Set<string>();
  const add = (name: string | null | undefined, from: string) => {
    const n = name?.trim();
    if (!n || !isModelName(n) || seen.has(n)) return;
    seen.add(n);
    out.push({ name: n, from });
  };
  for (const n of s.registry()) add(n, "registry");
  for (const k of MODEL_ENV_KEYS) add(s.env[k], k);
  add(await s.settingsModel().catch(() => null), "settings.json");
  for (const n of s.recentModels()) add(n, "usage");
  for (const n of CLI_ALIASES) add(n, "alias");
  return out;
}

export interface ModelDiscoveryDeps extends DiscoverySources {
  probe: (model: string) => Promise<ProbeOutcome>;
  /** 每探测完一个（已登记的模型用它更新健康状态）。 */
  onResult?: (name: string, from: string, r: ProbeOutcome) => void;
  now: () => number;
  onChange?: () => void;
  log?: (msg: string, err?: unknown) => void;
}

/** 首次设置和「重新发现」：列出能看到的模型，一个一个用最便宜的调用试，别的不碰。 */
export class ModelDiscovery {
  private state: DiscoveryView | null = null;
  private current: Promise<void> | null = null;

  constructor(private d: ModelDiscoveryDeps) {}

  view(): DiscoveryView | null {
    return this.state;
  }

  run(): Promise<void> {
    this.current ??= this.runOnce().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async runOnce(): Promise<void> {
    const cands = await discoveryCandidates(this.d);
    const models: DiscoveredModel[] = cands.map((c) => ({ ...c, status: "pending", message: null, suggestedTier: suggestTier(c.name, c.from) }));
    this.state = { running: true, at: this.d.now(), models };
    this.d.onChange?.();
    for (const m of models) {
      let r: ProbeOutcome;
      try {
        r = await this.d.probe(m.name);
      } catch (e) {
        this.d.log?.(`model discovery: probing ${m.name} failed`, e);
        r = { ok: false, hit: null, message: String(e) };
      }
      if (r.ok) {
        m.status = "available";
      } else {
        m.status = r.hit?.kind === "model_unavailable" ? "unavailable" : r.hit ? "limited" : "error";
        m.message = r.message.slice(0, 300);
      }
      try {
        this.d.onResult?.(m.name, m.from, r);
      } catch (e) {
        this.d.log?.("model discovery: onResult threw", e);
      }
      this.d.onChange?.();
    }
    this.state = { running: false, at: this.d.now(), models };
    this.d.onChange?.();
  }
}
