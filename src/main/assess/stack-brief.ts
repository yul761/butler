// 栈（工作流 K）开栈底 PR 时拿简报的入口。G 启动时把 BriefService.briefProvider 填进来；
// K 只依赖这里，不用等 G 的服务建好。没填时返回 null（和开关关着一样）。
import type { BriefLayer, BriefProvider } from "../../shared/prereview";

let provider: BriefProvider | null = null;

export function setStackBriefProvider(p: BriefProvider | null): void {
  provider = p;
}

export const stackBriefProvider: BriefProvider = (layer: BriefLayer) => (provider ? provider(layer) : null);
