import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS } from "../shared/ipc";

function assertAllowed(list: readonly string[], channel: string): void {
  if (!list.includes(channel)) throw new Error(`IPC channel not allowed: ${channel}`);
}

contextBridge.exposeInMainWorld("shipherd", {
  platform: process.platform,
  // 终端用什么画（BTL-242）：默认 WebGL；SHIPHERD_TERMINAL_RENDERER=dom 用 DOM（e2e 要读 .xterm-rows 里的字）。
  terminalRenderer: process.env.SHIPHERD_TERMINAL_RENDERER === "dom" ? "dom" : "webgl",
  // 留几个切走的终端的 xterm（BTL-242，默认 4）；e2e 测快照重建时设成 0。
  terminalCacheMax: /^\d+$/.test(process.env.SHIPHERD_TERMINAL_CACHE ?? "") ? Number(process.env.SHIPHERD_TERMINAL_CACHE) : null,
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    assertAllowed(INVOKE_CHANNELS, channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel: string, ...args: unknown[]): void {
    assertAllowed(SEND_CHANNELS, channel);
    ipcRenderer.send(channel, ...args);
  },
  on(channel: string, cb: (...args: unknown[]) => void): () => void {
    assertAllowed(EVENT_CHANNELS, channel);
    const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
