// 一个终端的 xterm（BTL-242）：建一次，切走只是从页面上摘下来（留在 terminal-cache 里），切回来挂回去。
// 输出一直写进去（摘下来的 xterm 不画，只解析）；主进程只给挂着的终端发 pty:data（pty:snapshot 挂上、pty:detach 摘下）。
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { api, platform, terminalCacheMaxPref, terminalRendererPref } from "../api";
import { setXtermRenderer } from "../diag";
import { reportError } from "../errors";
import { clipboardAction } from "../terminal-keys";
import { LruCache, TERMINAL_CACHE_MAX } from "../terminal-cache";

/** Ctrl+V 时剪贴板里没有文字（比如截图）：照常把 ^V 交给 claude，由它自己读剪贴板里的图片。 */
const CTRL_V = "\x16";

/** xterm 留的回滚行数（WS-M D）：主进程的快照另外留着 256 KB 的原始输出，第一次挂上时从快照重建。 */
export const TERMINAL_SCROLLBACK = 3000;

/** WebGL 画（快得多，尤其 Windows）；建不了或者上下文丢了就退回 DOM，诊断里记一笔。 */
function loadRenderer(term: Terminal): void {
  if (terminalRendererPref() === "dom") {
    setXtermRenderer("dom");
    return;
  }
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => {
      gl.dispose();
      setXtermRenderer("dom-fallback");
    });
    term.loadAddon(gl);
    setXtermRenderer("webgl");
  } catch {
    setXtermRenderer("dom-fallback");
  }
}

export class LiveTerminal {
  readonly host: HTMLDivElement;
  readonly term: Terminal;
  readonly fit = new FitAddon();
  exitCode: number | null = null;
  private opened = false;
  private loading = false;
  private ready = false;
  private disposed = false;
  private readonly offs: (() => void)[] = [];
  private onExitChange: ((code: number | null) => void) | null = null;

  constructor(readonly termId: string) {
    this.host = document.createElement("div");
    this.host.className = "terminal-host";
    this.term = new Terminal({ fontFamily: 'Menlo, Consolas, "Cascadia Mono", monospace', fontSize: 13, cursorBlink: true, scrollback: TERMINAL_SCROLLBACK });
    this.term.loadAddon(this.fit);
    const input = this.term.onData((d) => api.ptyWrite(termId, d));
    this.offs.push(() => input.dispose());
    // Windows / Linux 的 Ctrl+C / Ctrl+V（见 terminal-keys）。preventDefault 让菜单里的粘贴快捷键不再触发第二次。
    this.term.attachCustomKeyEventHandler((e) => {
      const action = clipboardAction(e, platform(), this.term.hasSelection());
      if (!action) return true;
      if (e.type === "keydown") {
        e.preventDefault();
        if (action === "copy") this.copySelection();
        else if (action === "paste") this.paste();
      }
      return false;
    });
  }

  get attached(): boolean {
    return this.host.isConnected;
  }

  /** 挂到页面上；第一次挂时才 open（xterm 要在文档里才量得出字宽）。 */
  attach(container: HTMLElement, onExitChange: (code: number | null) => void): void {
    container.appendChild(this.host);
    this.onExitChange = onExitChange;
    if (!this.opened) {
      this.opened = true;
      this.term.open(this.host);
      loadRenderer(this.term);
    }
  }

  detach(): void {
    this.onExitChange = null;
    this.host.remove();
  }

  /**
   * 第一次：挂上主进程那边（pty:snapshot）、写进快照。之前要先量好尺寸：新建的 xterm 是 80x24，按那个宽度重放按 200 列画的屏幕会错行。
   * 主进程按顺序发送数据事件和 invoke 的返回：快照返回之前收到的数据都已包含在快照里，直接丢弃。
   */
  load(): void {
    if (this.loading) return;
    this.loading = true;
    this.offs.push(
      api.onPtyData((id, data) => {
        if (id !== this.termId || !this.ready) return;
        this.term.write(data);
        // 退出后又收到数据，说明终端被重新打开（续接）了。
        if (this.exitCode !== null) this.setExit(null);
      }),
      api.onPtyExit((id, code) => {
        if (id === this.termId) this.setExit(code);
      }),
    );
    void api
      .ptySnapshot(this.termId)
      .then((snap) => {
        if (this.disposed) return;
        this.term.write(snap.data);
        this.setExit(snap.exitCode);
        this.ready = true;
      })
      .catch((e) => {
        this.ready = true;
        reportError(e);
      });
  }

  private setExit(code: number | null): void {
    this.exitCode = code;
    this.onExitChange?.(code);
  }

  copySelection(): void {
    api.clipboardWrite(this.term.getSelection()).catch(reportError);
    this.term.clearSelection();
  }

  paste(): void {
    // term.paste 处理换行和 claude 打开的 bracketed paste，多行文本不会被逐行当成回车提交。
    api.clipboardRead().then((text) => (text ? this.term.paste(text) : api.ptyWrite(this.termId, CTRL_V)), reportError);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs) off();
    if (this.loading) api.ptyDetach(this.termId);
    this.term.dispose();
    this.host.remove();
  }
}

let cache: LruCache<LiveTerminal> | null = null;
/** 最近看过的几个终端（BTL-242）。第一次用到时才建：模块加载时（比如测试里）还没有 window。 */
export function terminalCache(): LruCache<LiveTerminal> {
  cache ??= new LruCache<LiveTerminal>(terminalCacheMaxPref() ?? TERMINAL_CACHE_MAX, (_id, t) => t.dispose());
  return cache;
}
