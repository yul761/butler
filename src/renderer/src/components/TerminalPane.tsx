import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { api, pathForFile, platform } from "../api";
import { dropText } from "../drop";
import { reportError } from "../errors";
import { S } from "../strings";

export function TerminalPane({ termId, visible, onClose, onResume }: { termId: string; visible: boolean; onClose: () => void; onResume: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);

  useEffect(() => {
    const term = new Terminal({ fontFamily: 'Menlo, Consolas, "Cascadia Mono", monospace', fontSize: 13, cursorBlink: true, scrollback: 10_000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current!);
    termRef.current = term;
    fitRef.current = fit;

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
        if (snap.exitCode !== null) setExitCode(snap.exitCode);
        ready = true;
      })
      .catch((e) => {
        ready = true;
        reportError(e);
      });

    const input = term.onData((d) => api.ptyWrite(termId, d));
    const doFit = () => {
      if (!ref.current || ref.current.offsetParent === null) return;
      fit.fit();
      api.ptyResize(termId, term.cols, term.rows);
    };
    const ro = new ResizeObserver(doFit);
    ro.observe(ref.current!);

    return () => {
      disposed = true;
      ro.disconnect();
      offData();
      offExit();
      input.dispose();
      term.dispose();
    };
  }, [termId]);

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      const term = termRef.current;
      if (!term || !ref.current || ref.current.offsetParent === null) return;
      fitRef.current?.fit();
      api.ptyResize(termId, term.cols, term.rows);
      term.focus();
    });
  }, [visible, termId]);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    const paths = files.map((f) => pathForFile(f)).filter(Boolean);
    if (paths.length > 0) api.ptyWrite(termId, dropText(paths, platform()));
  }

  return (
    <div className="terminal-wrap" style={{ display: visible ? "flex" : "none" }} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {exitCode !== null && (
        <div className="exited">
          {S.exited(exitCode)} <button onClick={onResume}>{S.resume}</button> <button onClick={onClose}>{S.close}</button>
        </div>
      )}
      <div className="terminal" ref={ref} />
    </div>
  );
}
