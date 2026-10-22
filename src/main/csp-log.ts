/**
 * 渲染进程的 CSP 报错（任务 6）：主进程从 console-message 里认出它们，写进 main.log。
 * E2E（任务 9）用同样的判断和前缀断言一条都没有，所以放在这里，两边共用。
 */
export const CSP_VIOLATION_LOG_PREFIX = "renderer CSP violation:";

/** Chromium 报告 CSP 拦截的控制台消息都带这几个词。 */
export function isCspViolationMessage(message: string): boolean {
  return /Content Security Policy/i.test(message);
}
