import { NOTIFY_EVENTS, type NotifyEvent, type ProfileCandidate } from "../../shared/interrupts";

/** 候选按仓库分组（保持扫描给的顺序）。 */
export function groupCandidates(cs: readonly ProfileCandidate[]): { slug: string; items: ProfileCandidate[] }[] {
  const out = new Map<string, ProfileCandidate[]>();
  for (const x of cs) {
    const list = out.get(x.slug) ?? [];
    list.push(x);
    out.set(x.slug, list);
  }
  return [...out].map(([slug, items]) => ({ slug, items }));
}

export const pickKey = (slug: string, rule: string) => `${slug}\n${rule}`;

/** 默认勾上的：模型没标「值得再看一眼」的 Bash 规则。MCP 工具只按名字判断，默认不勾，要用户自己看。 */
export function defaultPicks(cs: readonly ProfileCandidate[]): Set<string> {
  return new Set(cs.filter((x) => !x.caution && !x.rule.startsWith("mcp__")).map((x) => pickKey(x.slug, x.rule)));
}

/** 设置里的事件列表（逗号分隔）→ 认识的事件，按固定顺序。 */
export function eventsOf(csv: string): NotifyEvent[] {
  const set = new Set(csv.split(",").map((s) => s.trim()));
  return NOTIFY_EVENTS.filter((e) => set.has(e));
}

export function toggleEvent(csv: string, ev: NotifyEvent, on: boolean): string {
  const set = new Set(eventsOf(csv));
  if (on) set.add(ev);
  else set.delete(ev);
  return NOTIFY_EVENTS.filter((e) => set.has(e)).join(",");
}

const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** 安静时段：空，或 HH:MM-HH:MM（两头不同）。主进程也会再校验一次。 */
export function quietValid(v: string): boolean {
  const t = v.trim();
  if (t === "") return true;
  const parts = t.split("-");
  if (parts.length !== 2) return false;
  const [a, b] = parts.map((p) => HM.exec(p.trim()));
  if (!a || !b) return false;
  return Number(a[1]) * 60 + Number(a[2]) !== Number(b[1]) * 60 + Number(b[2]);
}
