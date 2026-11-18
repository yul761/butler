import { SectionRegistry } from "./registry";
import { lessonsSection, policiesSection, productsSection } from "./sections";

export { ConfigIoService, type ConfigIoDeps, type BackupKind } from "./service";
export { SectionRegistry, type ConfigSection } from "./registry";
export type { LessonConflictDetector } from "./sections";

/** C 自带的三个部分；别的工作流（checks / models / permissions / baselines）各自 register。 */
export function defaultRegistry(): SectionRegistry {
  const r = new SectionRegistry();
  r.register(productsSection);
  r.register(policiesSection);
  r.register(lessonsSection);
  return r;
}
