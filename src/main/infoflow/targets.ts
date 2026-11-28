import type { FlowTarget } from "../../shared/infoflow";
import { featureScope, ticketScope, WORKSPACE_SCOPE } from "../../shared/memory";
import type { Session } from "../../shared/types";

/**
 * 信息流转（BTL-272）：模型写的 targets 字符串 → 解析好的目标；目标 → 写进哪一级记忆、发给哪些 session。
 * ticket、epic 一律按库里的核对过才算，对不上的丢掉（模型编的号不能把消息发到别处）。
 */

export interface TargetLookup {
  /** 按号找 ticket（不分大小写）；找不到为 null。 */
  ticket(key: string): { key: string; featureId: number | null } | null;
  /** 按 id 或名字找 epic（不分大小写，名字要完全一样）；找不到为 null。 */
  epic(idOrName: string): number | null;
}

/** 这一轮来源的 session 在哪：用来补全「coordinator」不带范围的写法，和解析不出任何目标时的默认目标。 */
export interface SourceInfo {
  ticketKey: string | null;
  /** 来源所在的 epic（ticket session 从 ticket 往上找）。 */
  featureId: number | null;
  /** 全局总控。 */
  shipherd: boolean;
}

const sameTarget = (a: FlowTarget, b: FlowTarget): boolean => JSON.stringify(a) === JSON.stringify(b);

/** 一个字符串 → 目标；认不出为 null。认 ticket:KEY、epic:ID|名字、coordinator[:ID|:global]、workspace，也认裸的 ticket 号。 */
export function parseTarget(raw: string, look: TargetLookup, src: SourceInfo): FlowTarget | null {
  const s = raw.trim();
  const m = /^(ticket|epic|coordinator|workspace)(?::\s*(.+))?$/i.exec(s);
  if (!m) {
    const t = look.ticket(s);
    return t ? { kind: "ticket", key: t.key } : null;
  }
  const kind = m[1].toLowerCase();
  const arg = m[2]?.trim() ?? "";
  if (kind === "workspace") return arg ? null : { kind: "workspace" };
  if (kind === "ticket") {
    const t = arg ? look.ticket(arg) : null;
    return t ? { kind: "ticket", key: t.key } : null;
  }
  if (kind === "epic") {
    const id = arg ? look.epic(arg) : src.featureId;
    return id === null ? null : { kind: "epic", featureId: id };
  }
  if (/^(global|shipherd)$/i.test(arg) || (!arg && src.shipherd)) return { kind: "coordinator", featureId: null };
  if (!arg) return src.featureId === null ? { kind: "coordinator", featureId: null } : { kind: "coordinator", featureId: src.featureId };
  const id = look.epic(arg);
  return id === null ? null : { kind: "coordinator", featureId: id };
}

/** 解析一组 targets，去重；一个都解析不出时用来源的范围：ticket session → 它的 ticket，epic 总控 → epic，全局 → workspace。 */
export function resolveTargets(raw: readonly string[], look: TargetLookup, src: SourceInfo): FlowTarget[] {
  const out: FlowTarget[] = [];
  for (const r of raw) {
    const t = parseTarget(r, look, src);
    if (t && !out.some((o) => sameTarget(o, t))) out.push(t);
  }
  if (out.length > 0) return out;
  if (src.ticketKey !== null) return [{ kind: "ticket", key: src.ticketKey }];
  if (src.featureId !== null) return [{ kind: "epic", featureId: src.featureId }];
  return [{ kind: "workspace" }];
}

/**
 * agent 说的（不是用户亲口说的）只在来源自己的范围里流转：来源的 ticket、来源 epic 里的 ticket、来源 epic 和它的总控。
 * agent 的话里可能有网页、文件、工具输出里的内容（提示注入），不能凭它把约定写进全局记忆、发到别的 epic、所有总控。
 * 都不在范围里：ticket 来源落回它自己的 ticket，epic 来源落回它的 epic（照旧记、照旧发，只是不出这个范围）；
 * 没有 ticket 也没有 epic 的来源（workspace、全局总控）是空的：这一条不记不发（不落回 workspace、全局）。
 */
export function withinSource(targets: readonly FlowTarget[], src: SourceInfo, epicOfTicket: (key: string) => number | null): FlowTarget[] {
  const ownEpic = (f: number | null): boolean => f !== null && f === src.featureId;
  const kept = targets.filter((t) => {
    if (t.kind === "ticket") return t.key === src.ticketKey || ownEpic(epicOfTicket(t.key));
    if (t.kind === "epic") return ownEpic(t.featureId);
    if (t.kind === "coordinator") return ownEpic(t.featureId);
    return false;
  });
  if (kept.length > 0) return kept;
  if (src.ticketKey !== null) return [{ kind: "ticket", key: src.ticketKey }];
  if (src.featureId !== null) return [{ kind: "epic", featureId: src.featureId }];
  return [];
}

export function targetLabel(t: FlowTarget): string {
  switch (t.kind) {
    case "ticket":
      return `ticket:${t.key}`;
    case "epic":
      return `epic:${t.featureId}`;
    case "workspace":
      return "workspace";
    case "coordinator":
      return t.featureId === null ? "coordinator:global" : `coordinator:${t.featureId}`;
  }
}

/**
 * 覆盖这些目标的最小一级记忆：都是同一个 ticket → 那个 ticket；都落在同一个 epic 里（它的 ticket、它自己、它的总控）→ 那个 epic；
 * 其余（跨 epic、workspace、全局总控、不属于 epic 的 ticket 和别的混在一起）→ workspace。
 */
export function narrowestScope(targets: readonly FlowTarget[], epicOfTicket: (key: string) => number | null): string {
  if (targets.length === 0) return WORKSPACE_SCOPE;
  const keys = new Set(targets.flatMap((t) => (t.kind === "ticket" ? [t.key] : [])));
  if (keys.size === 1 && targets.every((t) => t.kind === "ticket")) return ticketScope([...keys][0]);
  let epic: number | null | undefined;
  for (const t of targets) {
    const f = t.kind === "ticket" ? epicOfTicket(t.key) : t.kind === "epic" || t.kind === "coordinator" ? t.featureId : null;
    if (f === null) return WORKSPACE_SCOPE;
    if (epic === undefined) epic = f;
    else if (epic !== f) return WORKSPACE_SCOPE;
  }
  return epic === undefined || epic === null ? WORKSPACE_SCOPE : featureScope(epic);
}

export interface RecipientLookup {
  /** 这个 ticket 的 session 的 head（不含复盘分析、已隐藏的）。 */
  ticketHeads(key: string): Session[];
  /** 这个 epic 里所有 session 的 head：总控、修复 session、它的 ticket 的 session。 */
  epicHeads(featureId: number): Session[];
  /** epic 的总控（head）；没有为 null。 */
  coordinator(featureId: number): Session | null;
  /** 全局总控（head）；没有为 null。 */
  shipherd(): Session | null;
  /** 所有 epic 的总控（head）。 */
  coordinators(): Session[];
  /** 现在开着终端，或者休眠着（醒来就能收）。 */
  live(headId: string): boolean;
}

/**
 * 目标 → 要发的 session（head id），不含来源自己，不重复。
 * - ticket：开着或休眠着的那些；一个都没有就发给最近活动过的那个（排队，下次打开时送）。
 * - epic：只发开着或休眠着的；关着的下次打开时从 epic 记忆里读到。
 * - coordinator：那个总控，不管开没开（信箱排队，重要的叫醒它）。
 * - workspace：全局总控，加上开着或休眠着的 epic 总控；其余靠 workspace 记忆。
 */
export function recipients(targets: readonly FlowTarget[], look: RecipientLookup, sourceHead: string): string[] {
  const out = new Set<string>();
  const add = (s: Session | null | undefined): void => {
    if (s && s.id !== sourceHead) out.add(s.id);
  };
  for (const t of targets) {
    if (t.kind === "ticket") {
      const heads = look.ticketHeads(t.key);
      const live = heads.filter((h) => look.live(h.id));
      if (live.length > 0) live.forEach(add);
      else add([...heads].sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))[0]);
    } else if (t.kind === "epic") {
      look.epicHeads(t.featureId).filter((h) => look.live(h.id)).forEach(add);
    } else if (t.kind === "coordinator") {
      add(t.featureId === null ? look.shipherd() : look.coordinator(t.featureId));
    } else {
      add(look.shipherd());
      look.coordinators().filter((h) => look.live(h.id)).forEach(add);
    }
  }
  return [...out];
}

/**
 * 去重比较的范围：自己这一级，加上盖住它的几级（ticket → 它的 epic → workspace）。别的 epic、别的 ticket 说过的一样的话不算重复：
 * 那边知道了，这边还不知道。
 */
export function coveringScopes(scope: string, epicOfTicket: (key: string) => number | null): string[] {
  if (scope === WORKSPACE_SCOPE) return [WORKSPACE_SCOPE];
  const key = scope.startsWith("ticket:") ? scope.slice("ticket:".length) : null;
  if (key === null) return [scope, WORKSPACE_SCOPE];
  const f = epicOfTicket(key);
  return f === null ? [scope, WORKSPACE_SCOPE] : [scope, featureScope(f), WORKSPACE_SCOPE];
}

/** targetLabel 的反过来（库里存的是 label）；认不出为 null。 */
export function parseTargetLabel(label: string): FlowTarget | null {
  if (label === "workspace") return { kind: "workspace" };
  if (label === "coordinator:global") return { kind: "coordinator", featureId: null };
  const m = /^(ticket|epic|coordinator):(.+)$/.exec(label);
  if (!m) return null;
  if (m[1] === "ticket") return { kind: "ticket", key: m[2] };
  if (!/^\d+$/.test(m[2])) return null;
  return m[1] === "epic" ? { kind: "epic", featureId: Number(m[2]) } : { kind: "coordinator", featureId: Number(m[2]) };
}
