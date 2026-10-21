/** 主进程里给用户看的文案（系统通知、对话框、审计记录）。渲染进程的文案在 src/renderer/src/strings.ts。 */
export const N = {
  eveningTitle: "Butler 晚间小结",
  eveningBody: (n: number) => (n > 0 ? `${n} 个 ticket 今天有进展，点开查看。` : "今天没有新的 handoff。"),
  confirmTitle: "Butler：发送前确认",
  confirmMessage: "要把下面的内容发给你的个人 LLM 服务商，用来生成“今日重点”吗？",
  confirmSend: "发送",
  confirmCancel: "不发送",
  /** 审计里上次运行退出时还没发完的请求。 */
  auditStalePending: "Butler 在发送过程中退出，无法确认是否已发出",
};
