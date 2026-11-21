/**
 * 自动化档位（BTL-247）：全局档位、epic 档位，以及 epic 另选了档位时怎么盖在原来的开关上。
 * 设计：docs/superpowers/specs/2026-11-20-btl-247-automation-levels-design.md 第 3 节。
 *
 * - 全局档位是预设：apply 把受管开关写成那一档的值，之后运行时完全走原来的开关和三层策略。
 * - epic 档位是覆盖：它的 ticket 的受管行为按那一档的预设，盖过全局、产品、仓库三层。
 */
import {
  AUTOMATION_PRESETS, automationDisplay, externalOverride, GOVERNED_FAMILIES, GOVERNED_SETTINGS, isAutomationLevel, overlayLoop, overlayStack, preReviewOn,
  presetLayer, stackLevel, type AutomationLevel, type AutomationState, type GovernedFamily, type GovernedLayer, type GovernedSetting,
} from "../../shared/automation";
import type { ExternalActionSetting } from "../../shared/external";
import type { LoopPolicy } from "../../shared/loop-policy";
import type { StackPolicy } from "../../shared/stacks";

export interface AutomationDeps {
  setting(key: GovernedSetting | "automationLevel" | "intakeSource"): string;
  /** 写一个受管的设置项，并跑设置变了以后该跑的（预审重算、接活马上拉一次……）。 */
  writeSetting(key: GovernedSetting, value: "0" | "1"): void;
  /** 一族策略全局层现有的覆盖。 */
  globalLayer(family: GovernedFamily): Record<string, unknown>;
  /** 把一族策略的全局层整个换掉；失败抛错。 */
  writeLayer(family: GovernedFamily, layer: Record<string, unknown>): void;
  /** 三族策略各层设了的受管键。 */
  layers(): GovernedLayer[];
  /** epic（代码里是 feature）自己选的档位；没选或没有这个 epic 返回 null。 */
  featureLevel(featureId: number): AutomationLevel | null;
  /** ticket 属于哪个 epic；单独的 ticket 或不认识的 ticket 返回 null。 */
  ticketFeature(ticketKey: string): number | null;
  log?(msg: string, err?: unknown): void;
}

export class AutomationLevels {
  constructor(private readonly d: AutomationDeps) {}

  /** 存的全局档位；存坏了当手动。 */
  global(): AutomationLevel {
    const v = this.d.setting("automationLevel").trim();
    return isAutomationLevel(v) ? v : "manual";
  }

  /** 一个 epic 生效的档位：它自己选了就是它，否则全局；null（还没建的 epic）返回全局。 */
  levelForFeature(featureId: number | null): AutomationLevel {
    return (featureId === null ? null : this.d.featureLevel(featureId)) ?? this.global();
  }

  levelForTicket(ticketKey: string): AutomationLevel {
    return this.levelForFeature(this.d.ticketFeature(ticketKey));
  }

  /** 只有这个 epic 自己选了档位才返回它；跟随全局、还没建的 epic（null）返回 null（按原来的开关）。 */
  overrideForFeature(featureId: number | null): AutomationLevel | null {
    if (featureId === null) return null;
    try {
      return this.d.featureLevel(featureId);
    } catch (e) {
      this.d.log?.(`automation: reading the level of epic ${featureId} failed`, e);
      return null;
    }
  }

  /** 只有 ticket 所在的 epic 自己选了档位才返回它；跟随全局、单独的 ticket 返回 null（按原来的开关）。 */
  overrideForTicket(ticketKey: string | null | undefined): AutomationLevel | null {
    if (!ticketKey) return null;
    let f: number | null;
    try {
      f = this.d.ticketFeature(ticketKey);
    } catch (e) {
      this.d.log?.(`automation: reading the epic level of ${ticketKey} failed`, e);
      return null;
    }
    return this.overrideForFeature(f);
  }

  /** 把受管开关写成这一档的预设（设置项只写变了的；三族策略只改全局层的受管键）。 */
  apply(level: AutomationLevel): void {
    const p = AUTOMATION_PRESETS[level];
    for (const k of GOVERNED_SETTINGS) if (this.d.setting(k).trim() !== p.settings[k]) this.d.writeSetting(k, p.settings[k]);
    for (const family of GOVERNED_FAMILIES) {
      const existing = this.d.globalLayer(family);
      const next = presetLayer(family, existing, level);
      if (JSON.stringify(sorted(next)) !== JSON.stringify(sorted(existing))) this.d.writeLayer(family, next);
    }
  }

  /** 设置 › 自动化要的：存的档位、显示成什么、哪些开关对不上。 */
  state(): AutomationState {
    const level = this.global();
    const settings = Object.fromEntries(GOVERNED_SETTINGS.map((k) => [k, this.d.setting(k)])) as Record<GovernedSetting, string>;
    const { display, differs } = automationDisplay(level, { settings, layers: this.d.layers() });
    return { level, display, differs, intakeSourceSet: this.d.setting("intakeSource").trim() !== "none" && this.d.setting("intakeSource").trim() !== "" };
  }

  // ------------------------------------------------ 盖在原来的开关上

  loop(base: LoopPolicy, ticketKey: string | null | undefined): LoopPolicy {
    return overlayLoop(base, this.overrideForTicket(ticketKey));
  }

  /** 一个栈：看它每一层的 ticket（stackLevel 的规则）。 */
  stack(base: StackPolicy, ticketKeys: readonly (string | null)[]): StackPolicy {
    return overlayStack(base, stackLevel(ticketKeys.map((k) => this.overrideForTicket(k))));
  }

  /** ExternalActions 的 layered：epic 另选了档位、这是受管的对外开关时，返回预设的值。 */
  external(key: ExternalActionSetting, ticketKey: string | null | undefined): string | undefined {
    return externalOverride(this.overrideForTicket(ticketKey), key);
  }

  preReview(ticketKey: string | null | undefined, globalOn: boolean): boolean {
    return preReviewOn(this.overrideForTicket(ticketKey), globalOn);
  }
}

function sorted(o: Record<string, unknown>): [string, unknown][] {
  return Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
