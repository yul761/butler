import { SectionRegistry } from "./registry";
import { lessonsSection, policiesSection, productsSection } from "./sections";
import { checksSection } from "./checks-section";
import { modelsSection } from "./models-section";

export { ConfigIoService, type ConfigIoDeps, type BackupKind } from "./service";
export { SectionRegistry, type ConfigSection } from "./registry";
export type { LessonConflictDetector } from "./sections";

/** C 自带的三个部分；别的工作流（checks / models / permissions / baselines）各自 register。 */
export function defaultRegistry(): SectionRegistry {
  const r = new SectionRegistry();
  r.register(productsSection);
  r.register(policiesSection);
  r.register(lessonsSection);
  // E1：确定性检查（content: "checks"，不在起步包里）。
  r.register(checksSection);
  // A：模型路由（content: "config"，只在「全部」里）。
  r.register(modelsSection);
  return r;
}
