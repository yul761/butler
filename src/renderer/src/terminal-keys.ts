/** 终端里的复制粘贴快捷键。只看键盘事件的这几个字段，方便单测。 */
export interface KeyLike {
  type: string;
  key: string;
  /** 物理按键（KeyV / KeyC）：俄文、希腊文等布局下 key 是别的字母，按 code 判断。 */
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** swallow：吞掉这个按键，什么都不做。 */
export type ClipboardAction = "copy" | "paste" | "swallow";

/**
 * Windows / Linux 上 xterm 把 Ctrl+V 当成 ^V、Ctrl+C 当成 ^C 发给程序，外面复制的东西粘不进 claude。这里按 Windows Terminal 的习惯拦下：
 * - Ctrl+V、Ctrl+Shift+V：粘贴（剪贴板里没有文字时由调用方放行，claude 自己处理图片）。
 * - Ctrl+C：有选区时复制，没有选区时照常发 ^C（中断 claude）。Ctrl+Shift+C：有选区时复制，没有选区时什么都不做（不中断 claude）。
 * macOS 上 Cmd+C / Cmd+V 走系统菜单的原生复制粘贴，xterm 不拦，这里也不管。
 */
export function clipboardAction(e: KeyLike, platform: string, hasSelection: boolean): ClipboardAction | null {
  if (platform === "darwin" || !e.ctrlKey || e.altKey || e.metaKey) return null;
  const k = e.code === "KeyV" || e.code === "KeyC" ? e.code : e.key.toLowerCase() === "v" ? "KeyV" : e.key.toLowerCase() === "c" ? "KeyC" : null;
  if (k === "KeyV") return "paste";
  if (k === "KeyC") return hasSelection ? "copy" : e.shiftKey ? "swallow" : null;
  return null;
}
