import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { api, pathForFile, platform } from "../api";
import { dropText } from "../drop";
import { reportError } from "../errors";
import { S } from "../strings";
import { clipboardAction } from "../terminal-keys";
import { compositionShift } from "./composition-fit";

/** Ctrl+V 时剪贴板里没有文字（比如截图）：照常把 ^V 交给 claude，由它自己读剪贴板里的图片。 */
const CTRL_V = "\x16";

/** xterm 留的回滚行数（WS-M D）：主进程的快照另外留着 256 KB 的原始输出，切回来时从快照重建。 */
export const TERMINAL_SCROLLBACK = 3000;

/**
 * 只有看得见的终端才有 xterm（WS-M D）：切走就 dispose，切回来从主进程的快照重建，渲染进程里只留一个终端的缓冲区和 WebGL / DOM。
 * 可见性同时报给主进程（pty:visible），后台优先级（E）按它判断。
 */
export function TerminalPane({ termId, visible, onClose, onResume }: { termId: string; visible: boolean; onClose: () => void; onResume: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);

  useEffect(() => {
    if (!visible) return;
    api.ptyVisible(termId, true);
    const term = new Terminal({ fontFamily: 'Menlo, Consolas, "Cascadia Mono", monospace', fontSize: 13, cursorBlink: true, scrollback: TERMINAL_SCROLLBACK });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current!);
    termRef.current = term;

    const doFit = () => {
      if (!ref.current || ref.current.offsetParent === null) return;
      fit.fit();
      api.ptyResize(termId, term.cols, term.rows);
    };
    // 快照写进来之前先量好尺寸：新建的 xterm 是 80x24，按那个宽度重放按 200 列画的屏幕会错行，
    // 而尺寸和 pty 一样时 claude 收不到 SIGWINCH、不会重画，错的画面会一直留着。
    try {
      doFit();
    } catch {
      // 还量不出字宽：等下面的第一帧。
    }

    // 主进程按顺序发送数据事件和 invoke 的返回：快照返回之前收到的数据都已包含在快照里，直接丢弃。
    let ready = false;
    let disposed = false;
    const offData = api.onPtyData((id, data) => {
      if (id !== termId || !ready) return;
      term.write(data);
      // 退出后又收到数据，说明终端被重新打开（续接）了。
      setExitCode(null);
    });
    const offExit = api.onPtyExit((id, code) => {
      if (id === termId) setExitCode(code);
    });
    void api
      .ptySnapshot(termId)
      .then((snap) => {
        if (disposed) return;
        term.write(snap.data);
        setExitCode(snap.exitCode);
        ready = true;
      })
      .catch((e) => {
        ready = true;
        reportError(e);
      });
    const firstFrame = requestAnimationFrame(() => {
      if (disposed) return;
      doFit();
      term.focus();
    });

    const input = term.onData((d) => api.ptyWrite(termId, d));
    // Windows / Linux 的 Ctrl+C / Ctrl+V（见 terminal-keys）。preventDefault 让菜单里的粘贴快捷键不再触发第二次。
    term.attachCustomKeyEventHandler((e) => {
      const action = clipboardAction(e, platform(), term.hasSelection());
      if (!action) return true;
      if (e.type === "keydown") {
        e.preventDefault();
        if (action === "copy") copySelection(term);
        else if (action === "paste") pasteInto(term);
      }
      return false;
    });
    // 拼音框超出终端右边时往左移，保持可见。xterm 自己会写 left，所以只用 transform；结束输入时清掉。
    let fitFrame = 0;
    const fitComposition = () => {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        const view = ref.current?.querySelector<HTMLElement>(".composition-view");
        const wrap = ref.current?.parentElement;
        if (!view || !wrap) return;
        view.style.transform = "";
        if (!view.classList.contains("active")) return;
        const v = view.getBoundingClientRect();
        const w = wrap.getBoundingClientRect();
        const shift = compositionShift({ viewLeft: v.left - w.left, viewWidth: v.width, containerWidth: w.width });
        if (shift > 0) view.style.transform = `translateX(${-shift}px)`;
      });
    };
    const textarea = term.textarea;
    textarea?.addEventListener("compositionupdate", fitComposition);
    textarea?.addEventListener("compositionend", fitComposition);
    const ro = new ResizeObserver(doFit);
    ro.observe(ref.current!);

    return () => {
      disposed = true;
      api.ptyVisible(termId, false);
      ro.disconnect();
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(fitFrame);
      textarea?.removeEventListener("compositionupdate", fitComposition);
      textarea?.removeEventListener("compositionend", fitComposition);
      offData();
      offExit();
      input.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [termId, visible]);

  function copySelection(term: Terminal) {
    api.clipboardWrite(term.getSelection()).catch(reportError);
    term.clearSelection();
  }

  function pasteInto(term: Terminal) {
    // term.paste 处理换行和 claude 打开的 bracketed paste，多行文本不会被逐行当成回车提交。
    api.clipboardRead().then((text) => (text ? term.paste(text) : api.ptyWrite(termId, CTRL_V)), reportError);
  }

  // Windows / Linux 上右键和 Windows Terminal 一样：有选区复制，没有就粘贴。macOS 保持原样。
  function onContextMenu(e: React.MouseEvent) {
    const term = termRef.current;
    // 已退出的终端不再接收输入。
    if (platform() === "darwin" || !term || exitCode !== null) return;
    e.preventDefault();
    if (term.hasSelection()) copySelection(term);
    else pasteInto(term);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    const paths = files.map((f) => pathForFile(f)).filter(Boolean);
    if (paths.length > 0) api.ptyWrite(termId, dropText(paths, platform()));
  }

  return (
    <div className="terminal-wrap" style={{ display: visible ? "flex" : "none" }} onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onContextMenu={onContextMenu}>
      {exitCode !== null && (
        <div className="exited">
          {S.exited(exitCode)} <button onClick={onResume}>{S.resume}</button> <button onClick={onClose}>{S.close}</button>
        </div>
      )}
      <div className="terminal" ref={ref} />
    </div>
  );
}
