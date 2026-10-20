import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS } from "../shared/ipc";

function assertAllowed(list: readonly string[], channel: string): void {
  if (!list.includes(channel)) throw new Error(`IPC channel not allowed: ${channel}`);
}

contextBridge.exposeInMainWorld("butler", {
  platform: process.platform,
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
