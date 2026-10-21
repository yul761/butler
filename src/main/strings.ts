/** 主进程里给用户看的文案（系统通知）。渲染进程的文案在 src/renderer/src/strings.ts。 */
export const N = {
  eveningTitle: "Butler 晚间小结",
  eveningBody: (n: number) => (n > 0 ? `${n} 个 ticket 今天有进展，点开查看。` : "今天没有新的 handoff。"),
};
