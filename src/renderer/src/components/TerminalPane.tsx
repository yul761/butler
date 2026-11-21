import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import type { HibernateReason } from "../../../shared/types";
import { api, pathForFile, platform } from "../api";
import { dropText } from "../drop";
import { compositionShift } from "./composition-fit";
import { LiveTerminal, terminalCache } from "./live-terminal";
import { S } from "../strings";


/**
 * 看得见的终端挂着一个 xterm（WS-M D）；切走只是摘下来，最近看过的几个留在 terminalCache 里（BTL-242），切回来不用从快照重建。
 * 被挤出缓存的才 dispose，下次从主进程的快照重建。可见性同时报给主进程（pty:visible），后台优先级（E）按它判断。
 */
export function TerminalPane({ termId, visible, hibernated = null, onClose, onResume }: {
  termId: string;
  visible: boolean;
  /** 这个终端是 Butler 为了省内存结束的（WS-M B），值是原因：切到它就自动唤醒（--resume）。 */
  hibernated?: HibernateReason | null;
  onClose: () => void;
  onResume: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const liveRef = useRef<LiveTerminal | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  // 切到休眠的终端：每次休眠唤醒一次（失败了留着横幅，用户自己点恢复）。醒了、或者不再算休眠以后，下次休眠再自动唤醒。
  const woke = useRef(false);
  useEffect(() => {
    if (!hibernated || exitCode === null) woke.current = false;
  }, [hibernated, exitCode]);
  useEffect(() => {
    if (!visible || !hibernated || exitCode === null || woke.current) return;
    woke.current = true;
    onResume();
  }, [visible, hibernated, exitCode, onResume]);

  useEffect(() => {
    if (!visible) return;
    api.ptyVisible(termId, true);
    // 同一个终端已经挂在别处（两个视图同时开着）：这里另建一个不进缓存的，摘下时就拆掉。
    const cached = terminalCache().peek(termId);
    const own = cached?.attached ? new LiveTerminal(termId) : null;
    const live = own ?? terminalCache().acquire(termId, () => new LiveTerminal(termId));
    const { term, fit } = live;
    live.attach(ref.current!, setExitCode);
    setExitCode(live.exitCode);
    liveRef.current = live;

    const doFit = () => {
      if (!ref.current || ref.current.offsetParent === null) return;
      fit.fit();
      api.ptyResize(termId, term.cols, term.rows);
    };
    try {
      doFit();
    } catch {
      // 还量不出字宽：等下面的第一帧。
    }
    live.load();
    let disposed = false;
    const firstFrame = requestAnimationFrame(() => {
      if (disposed) return;
      doFit();
      // 挂回来的 xterm（WebGL 的画布换了位置）：整屏重画一次。
      term.refresh(0, term.rows - 1);
      term.focus();
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
      live.detach();
      if (own) own.dispose();
      else terminalCache().release(termId);
      liveRef.current = null;
    };
  }, [termId, visible]);

  // Windows / Linux 上右键和 Windows Terminal 一样：有选区复制，没有就粘贴。macOS 保持原样。
  function onContextMenu(e: React.MouseEvent) {
    const live = liveRef.current;
    // 已退出的终端不再接收输入。
    if (platform() === "darwin" || !live || exitCode !== null) return;
    e.preventDefault();
    if (live.term.hasSelection()) live.copySelection();
    else live.paste();
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
          {hibernated ? S.hib.reason[hibernated] : S.exited(exitCode)} <button onClick={onResume}>{hibernated ? S.hib.open : S.resume}</button> <button onClick={onClose}>{S.close}</button>
        </div>
      )}
      <div className="terminal" ref={ref} />
    </div>
  );
}
