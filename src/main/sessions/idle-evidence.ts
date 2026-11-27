import { createHash } from "node:crypto";
import { aboveInputBox, dialogOnScreen, inputBoxEmpty, permissionOnScreen, workingOnScreen } from "./screen";

/** 屏幕、输出、transcript 都要安静这么久，才拿屏幕当证据说它停着（BTL-269 B）。 */
export const IDLE_QUIET_MS = 45_000;

export interface IdleEvidenceDeps {
  /** 这个终端当前的一屏，暗色的字（输入框里的灰色提示）换成空格（TermScreen.lines({ dropDim: true })）。 */
  screen(termId: string): string[];
  /** 终端最后一次输出的时间；0 = 还没输出过。 */
  lastOutputAt(termId: string): number;
  /** transcript 或命令输出最后一次变长的时间（SessionActivity.lastOutputAt）；没有 transcript 为 null。 */
  transcriptGrewAt(headId: string): number | null;
  now(): number;
  quietMs?: number;
}

/**
 * 看这一屏和最后输出的时间，判断 session 是不是真的停着在等输入：
 * 屏幕上画着空的输入框（灰色提示不算字）、没有确认框和对话框、没有「esc to interrupt」那一行，
 * 终端输出停了 IDLE_QUIET_MS（或者输入框上面的内容这么久没变过：状态栏一直在刷新的情况），transcript 也这么久没变长。
 *
 * 用在 waitingForInput 卡在 false、活动卡在「在想」的时候（Stop hook 没来、transcript 没写结束）：四条都满足就当它停着，
 * 校正状态、放行消息（BTL-269 B）。working：屏幕上看得出这一轮还在跑，给挡住原因用。
 */
export class IdleEvidence {
  /** 每个终端上一次看到的「输入框以上的内容」的指纹和从什么时候开始没变。 */
  private readonly stable = new Map<string, { hash: string; since: number }>();
  /** 机器上一次睡醒的时间：睡着的时间不算安静（和 sessionCleanup.resumed 一样），安静从醒来起重新算。 */
  private resumedAt = -Infinity;

  constructor(private readonly d: IdleEvidenceDeps) {}

  /** idle：四条都满足；working：屏幕上看得出这一轮在跑；looksIdle：画着空输入框、没有转圈和确认框（还在等安静够久）。 */
  check(headId: string, termId: string): { idle: boolean; working: boolean; looksIdle: boolean } {
    const now = this.d.now();
    const quiet = this.d.quietMs ?? IDLE_QUIET_MS;
    const lines = this.d.screen(termId);
    const working = workingOnScreen(lines);
    const stableFor = this.stableFor(termId, lines, now);
    const empty = inputBoxEmpty(lines) === true;
    if (!empty || working || permissionOnScreen(lines) || dialogOnScreen(lines)) return { idle: false, working, looksIdle: false };
    const out = this.d.lastOutputAt(termId);
    const outputQuiet = (out > 0 && now - Math.max(out, this.resumedAt) >= quiet) || stableFor >= quiet;
    const grew = this.d.transcriptGrewAt(headId);
    const transcriptQuiet = now - Math.max(grew ?? -Infinity, this.resumedAt) >= quiet;
    return { idle: outputQuiet && transcriptQuiet, working: false, looksIdle: true };
  }

  /** 机器睡醒了（powerMonitor resume）：输出、transcript、屏幕的安静都从现在起重新算。 */
  resumed(): void {
    this.resumedAt = this.d.now();
  }

  /** 终端关了：忘掉它。 */
  forget(termId: string): void {
    this.stable.delete(termId);
  }

  private stableFor(termId: string, lines: string[], now: number): number {
    const hash = createHash("sha1").update((aboveInputBox(lines) ?? lines).join("\n")).digest("hex");
    const prev = this.stable.get(termId);
    if (prev?.hash === hash) return now - Math.max(prev.since, this.resumedAt);
    this.stable.set(termId, { hash, since: now });
    return 0;
  }
}

/**
 * 靠屏幕证据校正成「停着」的 session（BTL-269 B）：transcript 没写这一轮结束，活动还是「在想」，
 * 「需要你」只看活动是 waiting 的，就判断不到它最后那条回复（卡住的那一轮可能是用文字问了用户问题）。
 * 校正过、还停着的，给「需要你」的活动按 waiting 算；它再动起来（waitingForInput 变回 false）就忘掉。
 */
export class HealedTurns {
  private readonly ids = new Set<string>();

  add(headId: string): void {
    this.ids.add(headId);
  }

  /** 给「需要你」看的活动种类。 */
  kindFor<K extends string>(headId: string, waiting: boolean, kind: K | null): K | "waiting" | null {
    if (!this.ids.has(headId)) return kind;
    if (!waiting || (kind !== null && kind !== "thinking")) {
      this.ids.delete(headId);
      return kind;
    }
    return "waiting";
  }
}
