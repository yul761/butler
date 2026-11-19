import { SectionRegistry } from "./registry";
import { lessonsSection, policiesSection, productsSection } from "./sections";
import { checksSection } from "./checks-section";
import { modelsSection } from "./models-section";
import { baselineRulesSection, baselinesSection } from "./baselines-section";
import { permissionsSection } from "./permissions-section";
import { stacksSection } from "./stacks-section";
import { prPoliciesSection } from "./pr-policies-section";

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
  // E2：标记文件表的用户层，和（勾选时）各仓库的现状扫描。
  r.register(baselineRulesSection);
  r.register(baselinesSection);
  // J：权限档案（content: "config"）。导入的确认先进 pending。
  r.register(permissionsSection);
  // K：栈策略的三层覆盖（content: "config"，只在「全部」里）。
  r.register(stacksSection);
  // G：就绪度、证据、风险的三层策略。
  r.register(prPoliciesSection);
  return r;
}
