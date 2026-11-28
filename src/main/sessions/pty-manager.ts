import type { SpawnSpec } from "../claude/spawn";
import { dialogOnScreen, inputBoxEmpty, inputBoxText, pasteInInputBox, permissionOnScreen, squash, stableArea, TermScreen, type DimMode } from "./screen";

export interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type PtyFactory = (
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; cols: number; rows: number },
) => PtyProcess;

export interface PtyEvents {
  data(termId: string, data: string): void;
  exit(termId: string, exitCode: number): void;
  /** 终端开起来了（进程已经 spawn）。 */
  opened?(termId: string): void;
}

/** 每个终端保留的回放缓冲，切回 ticket 页面时重放。 */
export const BUFFER_LIMIT = 256 * 1024;

/** 回放缓冲最多多攒这么多再整块丢掉开头（BTL-242）：每次输出不再拼接、截取整个 256 KB 的字符串。 */
const BUFFER_SLACK = 64 * 1024;
/** 块太碎时先并成一块，免得数组太长。 */
const MAX_CHUNKS = 4096;

interface Term {
  proc: PtyProcess;
  /** 回放缓冲：按到达顺序的输出块，总长 chunkLen；回放（snapshot、退出）时才拼起来、按 BUFFER_LIMIT 截齐。 */
  chunks: string[];
  chunkLen: number;
  /** 这一次运行到现在一共输出了多少（字符）；缓冲里的是最后 chunkLen 个。epoch 区分同一个 termId 的每次运行。 */
  written: number;
  epoch: number;
  /** 已经截出缓冲的那部分输出留下的终端模式，回放时补在缓冲前面（见 modePrefix）。 */
  cutModes: Map<number, boolean>;
  lastOutputAt: number;
  exited: boolean;
  /** claude 的 SessionStart hook 到了（信任文件夹之类的启动对话框已经过去）。 */
  started: boolean;
  /** 用户上一次往这个终端写东西（渲染进程的按键，经 write）的时间；0 = 还没有。deliver、prefill 自己的写入不算。 */
  lastUserInputAt: number;
  /** 输入框里还没发出去的文字（按键推算，见 nextDraft）；"" = 没有草稿。hasDraft 还会拿屏幕上的输入框校正它。 */
  draft: string;
  /**
   * 用户上一次提交（回车）或屏幕上看到空输入框以后，又往里打过字（BTL-269 review）。只有这时屏幕上输入框里的字才可能是用户的：
   * Shipherd 自己贴进去没提交成的、claude 画的建议下一句都不是用户的草稿。
   */
  typedSinceEmpty: boolean;
  /**
   * 用户上一次回车提交之前输入框里的字；屏幕确认了（输入框空了、UserPromptSubmit 来了、之后又打了字）就是 null。
   * 回车之后屏幕上输入框里还是这些字：那次回车没提交（我们认不得的换行键），还是用户的草稿（PR #108 review 建议 1）。
   */
  submittedDraft: string | null;
  /** 上一次单独按 Esc（data 就是一个 \x1b）的时间；0 = 没有。隔得近的两次单独的 Esc 和 Esc Esc 一样清空输入框。 */
  lastEscAt: number;
  /** 终端打开（新开或恢复）的时间（R36：刚打开的终端不自动换新）。 */
  openedAt: number;
  /** 当前这一屏（BTL-190 第 9 点）：对话框、权限确认、输入框都看它，不看输出流的末尾。 */
  screen: TermScreen;
  /** 上一次 UserPromptSubmit 到的时间（markSubmitted）；0 = 还没有。deliver 回车以后等它确认送到。 */
  submittedAt: number;
  /**
   * deliver 粘贴之后、回车之前用户打的字（按顺序）：回车写进去以后再写，免得接在粘贴后面拼成一行一起提交。null = 不在这段空档里。
   * 终端自己发的报告（焦点、鼠标、查询的回复）不暂存。
   */
  held: string[] | null;
}

/** 终端输出去掉 ANSI 控制序列后的纯文本（只用来认对话框）。 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");
}

/** 删掉最后一个词（Ctrl+W、Option+Backspace）：先去掉末尾的空白，再去掉末尾连着的非空白。 */
function dropWord(text: string): string {
  return text.replace(/\s+$/, "").replace(/\S+$/, "");
}

/**
 * 输入框草稿的下一个值：current 是之前的文字，data 是这次写进终端的字节。
 * 鼠标上报、焦点事件、方向键等 ESC 序列不算；bracketed paste 的标记去掉但内容计入；
 * 回车（\r）、Ctrl+C、Ctrl+U、Esc Esc 清空，Ctrl+W、Option+Backspace 删掉一个词，单独的 \n、「\」后面的回车、Option+Enter（\x1b\r）
 * 算换行，退格删一个字，其他控制字符忽略。
 * 方向键挪光标、Ctrl+K 这类跟不上的编辑，由 hasDraft 拿屏幕上的输入框校正（BTL-269 C）。
 */
export function nextDraft(current: string, data: string): string {
  return scanDraft(current, data).text;
}

/**
 * nextDraft 的全部结果：submitted = data 里有真的提交（回车，不是 `\` 后面的回车、Option+Enter 这种换行）；
 * typedAfter = 最后一次提交之后还有输入；before = 最后一次提交之前输入框里的字（看屏幕确认那次回车真提交了没有，见 submittedDraft）。
 */
export function scanDraft(current: string, data: string): { text: string; submitted: boolean; typedAfter: boolean; before: string } {
  let chars = [...current];
  let submitted = false;
  let typedAfter = false;
  let before = "";
  // bracketed paste 里的内容整段计入（换行也算一个，粘贴的多行文本留在输入框里）；其余部分逐字符处理。
  // eslint-disable-next-line no-control-regex
  const parts = data.split(/\x1b\[200~([\s\S]*?)(?:\x1b\[201~|$)/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      chars.push(...parts[i]);
      if (submitted && parts[i] !== "") typedAfter = true;
      continue;
    }
    // 先认 Option+Backspace（\x1b\x7f）和 Esc Esc，免得被当成 ESC 序列去掉：换成 Ctrl+W、Ctrl+U。
    // 第二个 Esc 后面跟着 [ 或 O 的是 Alt+方向键这类（\x1b\x1b[A），不是 Esc Esc。
    // CSI 参数含 <（SGR 鼠标上报），SS3 带一个字符（\x1bOA），所以不直接用 stripAnsi；其余形状同它。
    // Option+Enter（\x1b\r）在 claude 的输入框里是换行，不是提交。
    const text = parts[i]
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\r/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\x7f/g, "\x17")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\x1b(?![[O])/g, "\x15")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bO.|\x1b[@-Z\\-_]/g, "");
    for (const ch of text) {
      if (submitted) typedAfter = true;
      // 「\」后面回车：claude 去掉那个 \、换一行，不提交。
      if (ch === "\r" && chars.at(-1) === "\\") {
        chars.pop();
        chars.push("\n");
      } else if (ch === "\r") {
        before = chars.join("");
        submitted = true;
        typedAfter = false;
        chars = [];
      } else if (ch === "\x03" || ch === "\x15") chars = [];
      else if (ch === "\x7f" || ch === "\b") chars.pop();
      else if (ch === "\x17") chars = [...dropWord(chars.join(""))];
      else if (ch === "\n") chars.push("\n"); // Ctrl+J：在输入框里换行，不提交
      else if (ch < " ") continue;
      else chars.push(ch);
    }
  }
  return { text: chars.join(""), submitted, typedAfter, before };
}

/** 只看长度的旧接口：nextDraft 的字数。 */
export function nextDraftLength(current: number, data: string): number {
  return [...nextDraft("x".repeat(current), data)].length;
}

/** NO_COLOR 时 claude 空输入框里的提示（不是暗色）：只在用户没打过字时按字认（PR #108 review 存疑 ii）。 */
const PLAIN_PLACEHOLDER = /^Try\s+["“]/;
/** 整段就是 claude 的提示（Try "…"）：听写读法读出来的是这个，也不当字（终端失焦时提示整段暗色，PR #108 第三轮 review）。 */
const WHOLE_PLACEHOLDER = /^Try\s+["“][^"”]*["”]$/;

/** 两次单独的 Esc 隔多久以内算一次 Esc Esc（claude 清空输入框）。 */
const ESC_ESC_MS = 1000;
/** 用户停手多久、终端输出停了多久以后，才拿屏幕上的输入框校正草稿：刚按的键、刚画的屏幕可能还没对上。 */
const DRAFT_SCREEN_QUIET_MS = 5000;
const DRAFT_OUTPUT_QUIET_MS = 1000;
/** deliver：输出一直不停（状态栏在刷新）时，输入框以上的内容这么久没变也算输入框就绪。 */
const SCREEN_STABLE_MS = 2000;

/**
 * 终端自己发出的报告（xterm 回答程序的查询、上报焦点和鼠标）：焦点 \x1b[I / \x1b[O、光标位置 CPR、设备属性 DA、
 * 模式查询的回复 DECRPM、kitty 键盘标志、OSC 回复、SGR 和 X10 鼠标上报。它们经渲染进程的 onData 写进来，但不是用户在操作（R37）。
 */
// eslint-disable-next-line no-control-regex
const TERMINAL_REPORT_RE = /\x1b\[[IO]|\x1b\[\d+;\d+R|\x1b\[[?>]?[\d;]*c|\x1b\[\?[\d;]*\$y|\x1b\[\?\d+u|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}/g;

/** 去掉终端自己发的报告之后还剩东西：才是用户的输入（方向键、Esc、Tab、Ctrl+C、打字都算）。 */
export function isUserInput(data: string): boolean {
  return data.replace(TERMINAL_REPORT_RE, "") !== "";
}

export interface DeliverOptions {
  /** 输出安静多久算输入框就绪。 */
  /** 输出不停时，输入框以上的内容多久没变算就绪（默认 SCREEN_STABLE_MS，不少于 idleMs）。 */
  screenStableMs?: number;
  idleMs?: number;
  /** 等 SessionStart 最多多久（没装 hook 时之后只靠安静 + 对话框检查）。 */
  startWaitMs?: number;
  /** 总共最多等多久（包括用户自己处理启动对话框的时间，除非 waitOutDialogs）。 */
  timeoutMs?: number;
  /**
   * 启动对话框（信任文件夹、新的 MCP server）还在屏幕上时不算超时：一直等到用户回答完再送，只有终端退出才放弃（BTL-262 审查）。
   * 总控交给新 session 的任务用它：超时了任务就丢了，总控却以为送到了。对话框消失以后才重新开始算 timeoutMs。
   */
  waitOutDialogs?: boolean;
  /** 粘贴之后，回显安静多久再回车；最多等 settleCapMs。 */
  settleMs?: number;
  settleCapMs?: number;
  /**
   * 把换行压成空格，作为一行发送。Windows 的 ConPTY 不一定把粘贴标记交给程序，粘贴里的换行就成了回车，
   * 任务会被拆成好几条消息提交（CI 上实际出现过）。
   */
  singleLine?: boolean;
  /**
   * 回车以后等 UserPromptSubmit 确认送到多久（只在这个终端的 hook 通着时等，即 SessionStart 到过）；没等到而输入框里还留着
   * 这次粘贴，就再按一次回车、再等这么久。
   */
  confirmMs?: number;
  /**
   * 粘贴前的最后一道复查（I2）：输入框就绪、马上要粘贴时调用（同步，中间不会插进别的事）。返回 false 就什么都不写，
   * deliver 返回 blocked。调用期间这一次 deliver 自己不算「在递」（autoInputInFlight），别的 deliver 还算。
   */
  recheck?: () => boolean;
}

/** blocked：recheck 在粘贴前说不行（用户刚输入过、别的自动输入在递、session 又忙了……），什么都没写。 */
export type DeliverResult = "sent" | "exited" | "timeout" | "blocked";

/** 最多保留多少个已退出终端的记录（用于快速失败的 claude 也能看到退出码）。 */
export const EXITED_LIMIT = 20;

/**
 * 回放缓冲超过上限时从头截掉。直接按字符截可能切在一个控制序列中间（回放时第一行乱码）：
 * 截完再丢到第一个换行之后（只在开头 4 KB 里找，找不到就原样保留）。
 */
export function trimBuffer(s: string): string {
  if (s.length <= BUFFER_LIMIT) return s;
  const cut = s.slice(-BUFFER_LIMIT);
  const nl = cut.indexOf("\n");
  return nl >= 0 && nl < 4096 ? cut.slice(nl + 1) : cut;
}

/**
 * DEC 私有模式（ESC [ ? n h / l）：备用屏幕、鼠标上报、bracketed paste、光标显示等。claude 的全屏界面只在启动和改尺寸时
 * 发这些序列；回放缓冲截掉开头后它们就没了，切回页面新建的终端不上报鼠标，滚轮到不了 claude（要改一下尺寸才恢复）。
 * 截掉的部分按顺序记下每个模式最后的开关，回放时先补上。
 */
export function recordModes(modes: Map<number, boolean>, text: string): void {
  // eslint-disable-next-line no-control-regex
  for (const m of text.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
    for (const n of m[1].split(";")) {
      if (n !== "") modes.set(Number(n), m[2] === "h");
    }
  }
}

export function modePrefix(modes: Map<number, boolean>): string {
  return [...modes].map(([n, on]) => `\x1b[?${n}${on ? "h" : "l"}`).join("");
}

export interface PtySnapshot {
  data: string;
  exitCode: number | null;
}

/** 输出里的一个位置（BTL-242）：渲染进程记着它看到了哪儿，挂回来时只要这之后的（PtyManager.since）。 */
export interface PtyMark {
  epoch: number;
  end: number;
}

export type MarkedSnapshot = PtySnapshot & { mark: PtyMark };

let nextEpoch = 1;

/** 记下一块输出；超过上限加余量时从头整块丢掉（丢掉的部分里的模式记下来），留下的总长不少于 BUFFER_LIMIT。 */
export function pushOutput(t: Pick<Term, "chunks" | "chunkLen" | "cutModes"> & Partial<Pick<Term, "written">>, data: string): void {
  if (t.written !== undefined) t.written += data.length;
  t.chunks.push(data);
  t.chunkLen += data.length;
  if (t.chunkLen <= BUFFER_LIMIT + BUFFER_SLACK) {
    if (t.chunks.length > MAX_CHUNKS) t.chunks = [t.chunks.join("")];
    return;
  }
  let drop = 0;
  let len = t.chunkLen;
  while (drop < t.chunks.length - 1 && len - t.chunks[drop].length >= BUFFER_LIMIT) len -= t.chunks[drop++].length;
  if (drop > 0) {
    recordModes(t.cutModes, t.chunks.slice(0, drop).join(""));
    t.chunks = t.chunks.slice(drop);
    t.chunkLen = len;
  }
  if (t.chunks.length > MAX_CHUNKS) t.chunks = [t.chunks.join("")];
}

/** 拼成回放内容：截到 BUFFER_LIMIT（同 trimBuffer），截掉部分的模式补在前面。拼好的留下来当一块。 */
function replay(t: Term): string {
  const joined = t.chunks.join("");
  const kept = trimBuffer(joined);
  if (kept.length < joined.length) recordModes(t.cutModes, joined.slice(0, joined.length - kept.length));
  t.chunks = kept === "" ? [] : [kept];
  t.chunkLen = kept.length;
  return modePrefix(t.cutModes) + kept;
}

/** 和 replay 一样的内容，但不动缓冲（重建主进程的屏幕时用：读屏幕不该让渲染进程的 since 补不上）。 */
function screenTail(t: Term): string {
  const joined = t.chunks.join("");
  const kept = trimBuffer(joined);
  if (kept.length === joined.length) return modePrefix(t.cutModes) + kept;
  const modes = new Map(t.cutModes);
  recordModes(modes, joined.slice(0, joined.length - kept.length));
  return modePrefix(modes) + kept;
}

export class PtyManager {
  private readonly terms = new Map<string, Term>();
  /** 已退出终端的回放内容（模式已经补在前面）。 */
  private readonly exited = new Map<string, { buffer: string; exitCode: number; mark: PtyMark }>();
  /** 每个终端正在进行的 deliver 有几个（I2）：DeliveryGuard 看到有就当作忙，别的自动输入不往里贴。 */
  private readonly inFlight = new Map<string, number>();

  constructor(
    private readonly factory: PtyFactory,
    private readonly events: PtyEvents,
    private readonly now: () => number = () => Date.now(),
    private readonly log: (msg: string, err?: unknown) => void = () => undefined,
  ) {}

  private guard(termId: string, what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.log(`pty ${termId}: ${what} failed`, e);
    }
  }

  open(termId: string, spec: SpawnSpec, opts: { cwd: string; env: Record<string, string>; cols?: number; rows?: number }): void {
    if (this.terms.has(termId)) throw new Error(`terminal ${termId} already open`);
    this.exited.delete(termId);
    const proc = this.factory(spec.file, spec.args, { cwd: opts.cwd, env: opts.env, cols: opts.cols ?? 120, rows: opts.rows ?? 32 });
    const cols = opts.cols ?? 120, rows = opts.rows ?? 32;
    const term: Term = {
      proc, chunks: [], chunkLen: 0, written: 0, epoch: nextEpoch++, cutModes: new Map(), lastOutputAt: 0, exited: false, started: false, lastUserInputAt: 0, draft: "", typedSinceEmpty: false, submittedDraft: null, lastEscAt: 0, openedAt: this.now(),
      // 屏幕解析抛错时用回放缓冲重建（BTL-277）：和渲染进程挂终端时重放的是同一份。
      screen: new TermScreen(cols, rows, () => screenTail(term)), submittedAt: 0, held: null,
    };
    this.terms.set(termId, term);
    proc.onData((data) => {
      // ConPTY 在进程退出后还可能吐出尾部数据；退出后一律丢弃，否则渲染进程会以为终端被重新打开而清掉退出提示。
      if (term.exited) return;
      term.lastOutputAt = this.now();
      pushOutput(term, data);
      this.guard(termId, "screen write", () => term.screen.write(data));
      this.events.data(termId, data);
    });
    proc.onExit(({ exitCode }) => {
      term.exited = true;
      this.guard(termId, "screen dispose", () => term.screen.dispose());
      this.terms.delete(termId);
      this.exited.delete(termId);
      this.exited.set(termId, { buffer: replay(term), exitCode, mark: { epoch: term.epoch, end: term.written } });
      while (this.exited.size > EXITED_LIMIT) this.exited.delete(this.exited.keys().next().value as string);
      this.events.exit(termId, exitCode);
    });
    this.guard(termId, "opened hook", () => this.events.opened?.(termId));
  }

  isOpen(termId: string): boolean {
    return this.terms.has(termId);
  }

  openIds(): string[] {
    return [...this.terms.keys()];
  }

  /** 打开的终端里那个进程的 pid；终端不在了返回 null。 */
  pid(termId: string): number | null {
    return this.terms.get(termId)?.proc.pid ?? null;
  }

  /** 屏幕上有权限确认或启动对话框（信任文件夹、MCP）：在等用户回答，总控不能替用户结束它。终端不在了返回 false。 */
  screenNeedsUser(termId: string): boolean {
    const lines = this.screenLines(termId);
    return permissionOnScreen(lines) || dialogOnScreen(lines);
  }

  /** 屏幕上有启动对话框（信任文件夹、新的 MCP server）：claude 还没开始，在等用户回答。终端不在了返回 false。 */
  startupDialogShowing(termId: string): boolean {
    return dialogOnScreen(this.screenLines(termId));
  }

  /** 屏幕上有权限确认（或退出计划模式的提示）：session 在等人点，不算卡住。终端不在了返回 false。 */
  permissionShowing(termId: string): boolean {
    return permissionOnScreen(this.screenLines(termId));
  }

  /** 当前这一屏的文字；终端不在了返回空数组。dropDim：暗色的字（输入框里的灰色提示）换成空格（BTL-269）。 */
  screenLines(termId: string, o: { dropDim?: DimMode } = {}): string[] {
    const t = this.terms.get(termId);
    if (!t) return [];
    try {
      return t.screen.lines(o);
    } catch (e) {
      this.log(`pty ${termId}: reading the screen failed`, e);
      return [];
    }
  }

  /** 等这个终端已有的输出都画到屏幕上（测试和需要马上看屏幕的地方用）。 */
  async screenSettled(termId: string): Promise<void> {
    await this.terms.get(termId)?.screen.flush();
  }

  /** 用户的输入（渲染进程的按键）。终端自己发的报告（焦点、鼠标、查询的回复）照样写进去，但不算用户输入过（R37）。 */
  write(termId: string, data: string): void {
    const t = this.terms.get(termId);
    if (t) {
      const user = isUserInput(data);
      const now = this.now();
      const s = scanDraft(t.draft, data);
      if (user) {
        t.lastUserInputAt = now;
        // 回车提交了：输入框又空了。只算最后一次提交后面还有没有打字；`\` 后面的回车、Option+Enter 是换行，不算提交。
        t.typedSinceEmpty = !s.submitted || s.typedAfter;
        // 提交前的字记下来：之后屏幕上输入框里还是这些字，就是那次回车没提交（checkDraftOnScreen）。
        t.submittedDraft = s.submitted && !s.typedAfter && s.before !== "" ? s.before : null;
      }
      if (data === "\x1b") {
        // 单独的 Esc：和上一次单独的 Esc 隔得近，就是 Esc Esc（claude 清空输入框）。
        if (t.lastEscAt > 0 && now - t.lastEscAt <= ESC_ESC_MS) {
          t.draft = "";
          t.lastEscAt = 0;
        } else t.lastEscAt = now;
      } else {
        if (user) t.lastEscAt = 0;
        t.draft = s.text;
      }
      if (user && t.held) {
        t.held.push(data);
        return;
      }
    }
    this.guard(termId, "write", () => t?.proc.write(data));
  }

  /**
   * Shipherd 自己按 Esc 打断正在跑的这一轮（成本熔断暂停，工作流 L）。不算用户输入：
   * 不然熔断会把自己的 Esc 当成「用户接手了」，之后再也不结束还在花钱的终端。草稿也不动。
   */
  interrupt(termId: string): void {
    const t = this.terms.get(termId);
    if (!t) return;
    this.guard(termId, "write", () => t.proc.write("\x1b"));
  }

  /** 用户最后一次回车之后有没有打过可见字符（还没发出去）。Shipherd 的 prefill 也算草稿；deliver 不算。终端不在了返回 false。 */
  hasDraft(termId: string): boolean {
    const t = this.terms.get(termId);
    if (!t) return false;
    this.checkDraftOnScreen(termId, t);
    return t.draft !== "";
  }

  /**
   * 拿屏幕上的输入框校正按键推算的草稿（BTL-269 C）：用户停手、输出也停了一会儿，屏幕上画着空输入框（灰色提示不算字），
   * 草稿就清掉（方向键、Ctrl+K、历史记录这些按键跟不上）；输入框里有字、推算却是空的，而且用户提交以后又打过字，就当有草稿
   * （不能把用户的字一起提交）。用户没打过字时输入框里的字不是用户的（Shipherd 没提交成的粘贴、claude 的建议下一句），不当草稿。
   * 没画输入框（对话框、菜单、还没画出来）不动。
   */
  private checkDraftOnScreen(termId: string, t: Term): void {
    const now = this.now();
    if (t.lastUserInputAt > 0 && now - t.lastUserInputAt < DRAFT_SCREEN_QUIET_MS) return;
    if (t.lastOutputAt > 0 && now - t.lastOutputAt < DRAFT_OUTPUT_QUIET_MS) return;
    const box = this.boxState(termId, t);
    if (box.empty === true) {
      t.typedSinceEmpty = false;
      t.submittedDraft = null;
      if (t.draft !== "") {
        this.log(`pty ${termId}: the input box is empty on screen; dropping a stale draft of ${[...t.draft].length} chars`);
        t.draft = "";
      }
    } else if (box.empty === false && t.draft === "") {
      // 回车以后输入框里还是回车前的那些字：那次回车没提交（换行键我们没认出来），是用户的草稿。
      if (!t.typedSinceEmpty && t.submittedDraft !== null && squash(box.text).startsWith(squash(t.submittedDraft))) {
        this.log(`pty ${termId}: the input box still shows what was there before Enter; keeping it as the user's draft`);
        t.typedSinceEmpty = true;
      }
      t.submittedDraft = null;
      if (t.typedSinceEmpty) t.draft = box.text;
    }
  }

  /**
   * 输入框空不空（BTL-269）：true 空、false 有字、null 没画输入框或读不出。lines 是 dropDim 读出来的一屏，不给就自己读。
   * 灰色提示按画法去掉（见 TermScreen.lines），另外照顾两种画法（PR #108 review）：
   * - 用户打过字以后，输入框里暗色的字后面紧跟着光标（语音听写还没定下来的字）：不当空。整段暗色、没有光标的
   *   （终端失焦时的提示）和整段是 Try "…" 的照样当空。
   * - 用户没打过字，输入框里是不带颜色的 Try "…"（NO_COLOR 时提示不是暗色）：当空。用户打过字时不按字认（C1）。
   * 终端不在了返回 null。
   */
  inputBoxEmpty(termId: string, lines?: string[]): boolean | null {
    const t = this.terms.get(termId);
    return t ? this.boxState(termId, t, lines).empty : null;
  }

  /** inputBoxEmpty 加上输入框里算用户的那些字（听写中的暗色字也算）。 */
  private boxState(termId: string, t: Term, given?: string[]): { empty: boolean | null; text: string } {
    try {
      const lines = given ?? t.screen.lines({ dropDim: true });
      const empty = inputBoxEmpty(lines);
      const text = inputBoxText(lines) ?? "";
      if (empty === true && t.typedSinceEmpty) {
        // 听写：暗色字后面紧跟着光标才算（screen.ts 的 "dictation"）。失焦时的提示没有光标，读出来是空的。
        const dictated = (inputBoxText(t.screen.lines({ dropDim: "dictation" })) ?? "").trim();
        if (dictated !== "" && !WHOLE_PLACEHOLDER.test(dictated)) return { empty: false, text: dictated };
      }
      if (empty === false && !t.typedSinceEmpty && PLAIN_PLACEHOLDER.test(text)) return { empty: true, text: "" };
      return { empty, text };
    } catch (e) {
      this.log(`pty ${termId}: reading the screen failed`, e);
      return { empty: null, text: "" };
    }
  }

  /** 终端最后一次输出的时间；还没输出过、终端不在了返回 0。 */
  lastOutputAt(termId: string): number {
    return this.terms.get(termId)?.lastOutputAt ?? 0;
  }

  /** 用户上一次在这个终端里输入的时间；没输入过、终端不在了返回 0。往里贴通知前看它，免得把用户打了一半的话一起提交。 */
  lastUserInputAt(termId: string): number {
    return this.terms.get(termId)?.lastUserInputAt ?? 0;
  }

  /** 终端打开（新开或恢复）的时间；终端不在了返回 0。 */
  openedAt(termId: string): number {
    return this.terms.get(termId)?.openedAt ?? 0;
  }

  /** 这个终端里有 Shipherd 的 deliver 正在进行（在等输入框就绪、在粘贴、在等回车）。 */
  autoInputInFlight(termId: string): boolean {
    return (this.inFlight.get(termId) ?? 0) > 0;
  }

  /**
   * 先占住这个终端：到返回的 release 被调用之前，autoInputInFlight 一直是 true。给「要把第一条消息交给刚启动的 claude」的路径用——
   * 从启动（SessionStart 之前）起就要让 guard 看到有自动输入在路上，否则 claude 一停在空输入框上，别的自动输入就能插进来。
   * release 只生效一次。
   */
  reserve(termId: string): () => void {
    this.hold(termId, 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.hold(termId, -1);
    };
  }

  private hold(termId: string, delta: 1 | -1): void {
    const n = (this.inFlight.get(termId) ?? 0) + delta;
    if (n > 0) this.inFlight.set(termId, n);
    else this.inFlight.delete(termId);
  }

  resize(termId: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) {
      this.guard(termId, "resize", () => this.terms.get(termId)?.proc.resize(cols, rows));
      // claude 按 pty 的尺寸画界面：屏幕模型的尺寸不跟上，光标定位就全错了。
      this.guard(termId, "screen resize", () => this.terms.get(termId)?.screen.resize(cols, rows));
    }
  }

  kill(termId: string): void {
    this.guard(termId, "kill", () => this.terms.get(termId)?.proc.kill());
  }

  killAll(): void {
    for (const [id, t] of [...this.terms]) this.guard(id, "kill", () => t.proc.kill());
  }

  snapshot(termId: string): PtySnapshot {
    const live = this.terms.get(termId);
    if (live) return { data: replay(live), exitCode: null };
    const done = this.exited.get(termId);
    if (done) return { data: done.buffer, exitCode: done.exitCode };
    return { data: "", exitCode: null };
  }

  /** 快照加上它对应的位置（渲染进程挂上终端时用）。 */
  snapshotAt(termId: string): MarkedSnapshot {
    const live = this.terms.get(termId);
    if (live) return { data: replay(live), exitCode: null, mark: { epoch: live.epoch, end: live.written } };
    const done = this.exited.get(termId);
    if (done) return { data: done.buffer, exitCode: done.exitCode, mark: done.mark };
    return { data: "", exitCode: null, mark: { epoch: 0, end: 0 } };
  }

  /**
   * mark 之后的输出（BTL-242）：摘下来的终端挂回去时补上中间那段，不用整份重放。
   * 补不上时返回 null：那段已经截出缓冲、终端重开过（epoch 不同）、mark 不对，或者终端退出后还有没看到的输出（退出时的缓冲已经拼过，不再按位置切）。
   */
  since(termId: string, mark: PtyMark): MarkedSnapshot | null {
    const live = this.terms.get(termId);
    if (live) {
      if (live.epoch !== mark.epoch || mark.end > live.written) return null;
      const want = live.written - mark.end;
      if (want > live.chunkLen) return null;
      // 从后往前拿够 want 个字符，不拼整个缓冲。
      const parts: string[] = [];
      let got = 0;
      for (let i = live.chunks.length - 1; i >= 0 && got < want; i--) {
        const c = live.chunks[i];
        const need = want - got;
        parts.push(c.length <= need ? c : c.slice(c.length - need));
        got += Math.min(c.length, need);
      }
      return { data: parts.reverse().join(""), exitCode: null, mark: { epoch: live.epoch, end: live.written } };
    }
    const done = this.exited.get(termId);
    if (done && done.mark.epoch === mark.epoch && done.mark.end === mark.end) return { data: "", exitCode: done.exitCode, mark: done.mark };
    return null;
  }

  /** claude 的 SessionStart hook 到了：启动对话框已经过去，可以交任务了。 */
  markStarted(termId: string): void {
    const t = this.terms.get(termId);
    if (t) t.started = true;
  }

  /** SessionStart 到过没有（唤醒等的就是它，WS-M B）。终端不在了为 false。 */
  started(termId: string): boolean {
    return this.terms.get(termId)?.started === true;
  }

  /** 这个终端的 claude 收下了一条输入（UserPromptSubmit hook）：deliver 回车以后等的就是它。 */
  markSubmitted(termId: string): void {
    const t = this.terms.get(termId);
    if (!t) return;
    t.submittedAt = this.now();
    // 来了 UserPromptSubmit：那次回车是真的提交了。
    t.submittedDraft = null;
  }

  /**
   * 把任务作为第一条消息交给刚启动的 claude（总控开子 session）：等 SessionStart（或者等满 startWaitMs）、输出安静、
   * 屏幕上没有信任文件夹 / MCP 之类的启动对话框，才把文本当作一次粘贴（bracketed paste）写进去；回显安静之后回车。
   * 对话框一直在（用户还没处理）就一直等到 timeoutMs，绝不替用户回答。text 里不能有 ESC（调用方先 sanitizeTask）。
   * 从开始到返回，这个终端都算有自动输入在递（autoInputInFlight，I2）。
   */
  async deliver(termId: string, text: string, o: DeliverOptions = {}): Promise<DeliverResult> {
    // 同步记上：调用方过完 guard 马上调 deliver，中间没有 await，别的调用方的 guard 从这一刻起就看到它。
    this.hold(termId, 1);
    try {
      return await this.deliverOnce(termId, text, o);
    } finally {
      this.hold(termId, -1);
    }
  }

  /** 复查时自己这一次不算在递。 */
  private recheckPasses(termId: string, recheck: () => boolean): boolean {
    this.hold(termId, -1);
    try {
      return recheck();
    } catch (e) {
      this.log(`pty ${termId}: deliver recheck failed`, e);
      return false;
    } finally {
      this.hold(termId, 1);
    }
  }

  private async deliverOnce(termId: string, text: string, o: DeliverOptions): Promise<DeliverResult> {
    const idleMs = o.idleMs ?? 800;
    const stableMs = Math.max(idleMs, o.screenStableMs ?? SCREEN_STABLE_MS);
    const start = this.now();
    let budgetFrom = start;
    /** 输入框以上的内容和从什么时候起没变（null = 没画输入框）。 */
    let shown = null as { key: string; since: number } | null;
    for (;;) {
      const t = this.terms.get(termId);
      if (!t || t.exited) return "exited";
      const now = this.now();
      // 从终端打开起算（BTL-279）：开了很久、只是 SessionStart 没来的不再从这次 deliver 起重新等一分钟（deliver 自己也只等一分钟）。
      const started = t.started || now - Math.min(start, t.openedAt) >= (o.startWaitMs ?? 60_000);
      let idle = t.lastOutputAt > 0 && now - t.lastOutputAt >= idleMs;
      if (!idle && started && t.lastOutputAt > 0) {
        // 输出一直不停，但只是输入框下面的状态栏在刷新（BTL-269 review）：输入框以上的内容 stableMs 没变也算就绪。
        const above = stableArea(this.screenLines(termId));
        const key = above === null ? null : above.join("\n");
        if (key === null) shown = null;
        else if (shown?.key !== key) shown = { key, since: now };
        else if (now - shown.since >= stableMs) idle = true;
      }
      const dialog = (started && idle) || o.waitOutDialogs ? dialogOnScreen(this.screenLines(termId)) : false;
      if (dialog && o.waitOutDialogs) budgetFrom = now;
      if (started && idle && !dialog) {
        if (o.recheck && !this.recheckPasses(termId, o.recheck)) return "blocked";
        // 粘贴里的换行按终端的惯例写成 \r（xterm 的粘贴也是这样）：Windows 的 ConPTY 会吞掉输入里的 \n。
        const body = o.singleLine ? text.replace(/\s*\r?\n\s*/g, " ") : text.replace(/\r?\n/g, "\r");
        this.guard(termId, "deliver paste", () => t.proc.write(`\x1b[200~${body}\x1b[201~`));
        t.held = [];
        break;
      }
      if (now - budgetFrom >= (o.timeoutMs ?? 300_000)) return "timeout";
      await new Promise((r) => setTimeout(r, 100));
    }
    // 长文本的回显（Windows 的 ConPTY 尤其慢）停下来之后再回车，免得提交半截。
    // 这段空档里用户的按键先暂存（held），回车之后照原样写进去：最多暂存 settleCapMs。
    const pasted = this.now();
    for (;;) {
      const t = this.terms.get(termId);
      if (!t || t.exited) {
        if (t) t.held = null;
        return "exited";
      }
      const now = this.now();
      if ((now - Math.max(t.lastOutputAt, pasted) >= (o.settleMs ?? 300)) || now - pasted >= (o.settleCapMs ?? 5000)) {
        this.guard(termId, "deliver enter", () => t.proc.write("\r"));
        const held = t.held ?? [];
        t.held = null;
        for (const d of held) this.guard(termId, "write held", () => t.proc.write(d));
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    // 「/clear」这类内置命令不触发 UserPromptSubmit，等也等不到。
    return this.confirm(termId, text, pasted, text.startsWith("/") ? 0 : (o.confirmMs ?? 10_000));
  }

  /**
   * 回车以后确认 claude 收下了（BTL-190 第 9 点）：等 UserPromptSubmit。没等到、输入框里还留着这次粘贴，就再按一次回车再等；
   * 还是没等到只记日志。不重贴：东西已经写进去了，重贴可能发两遍。hook 不通（SessionStart 从没到过）就不等，没有可等的信号。
   * 回车已经写进去了，所以这里一律返回 sent（终端中途退出也是）：返回 exited 调用方会当没送到、重开以后再送一遍。
   */
  private async confirm(termId: string, text: string, pasted: number, confirmMs: number): Promise<DeliverResult> {
    const t0 = this.terms.get(termId);
    if (!t0 || t0.exited || !t0.started || confirmMs <= 0) return "sent";
    for (let attempt = 0; attempt < 2; attempt++) {
      const entered = this.now();
      for (;;) {
        const t = this.terms.get(termId);
        if (t && t.submittedAt >= entered) return "sent";
        if (!t || t.exited) return "sent";
        if (this.now() - entered >= confirmMs) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const t = this.terms.get(termId);
      if (!t || t.exited) return "sent";
      if (attempt > 0 || !this.safeToPressEnterAgain(termId, t, text, pasted)) break;
      this.log(`pty ${termId}: the delivered text is still in the input box ${confirmMs / 1000} seconds after Enter; pressing Enter again`);
      this.guard(termId, "deliver enter again", () => t.proc.write("\r"));
    }
    this.log(`pty ${termId}: no UserPromptSubmit within ${confirmMs / 1000} seconds of delivering a message; it may not have been submitted`);
    return "sent";
  }

  /**
   * 补按回车之前：用户从粘贴以后没碰过这个终端（不然输入框里可能是他的草稿），屏幕上没有对话框和权限确认（回车会替他选默认项），
   * 输入框画着、里面还是这次粘贴。
   */
  private safeToPressEnterAgain(termId: string, t: Term, text: string, pasted: number): boolean {
    if (t.lastUserInputAt >= pasted) return false;
    const lines = this.screenLines(termId);
    return !dialogOnScreen(lines) && !permissionOnScreen(lines) && pasteInInputBox(lines, text);
  }

  /** 等 claude 的界面输出停下来（输入框就绪）后把文本写进去，不回车。 */
  async prefill(termId: string, text: string, idleMs = 800, timeoutMs = 20_000): Promise<boolean> {
    const start = this.now();
    for (;;) {
      const t = this.terms.get(termId);
      if (!t || t.exited) return false;
      const now = this.now();
      if (t.lastOutputAt > 0 && now - t.lastOutputAt >= idleMs) {
        this.guard(termId, "prefill write", () => t.proc.write(text));
        t.draft = nextDraft(t.draft, text);
        // 输入框里有了这些字：按字认提示（NO_COLOR 的 Try "…"）的规矩不能把它当空。
        if (t.draft !== "") t.typedSinceEmpty = true;
        return true;
      }
      if (now - start >= timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
