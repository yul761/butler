/**
 * 渲染进程的 Content-Security-Policy。界面只加载 app 自己的文件，从不联网（个人 API 在主进程的 gateway 里）。
 * xterm 会往页面里插 <style>，所以样式允许内联；脚本不允许内联，也没有 unsafe-eval。
 */
export const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** 开发模式：Vite 的 React 热更新要一段内联脚本和本机的 websocket。 */
export const DEV_CSP = PROD_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace(
  "connect-src 'self'",
  "connect-src 'self' ws://localhost:* http://localhost:*",
);

export const CSP_PLACEHOLDER = "%BUTLER_CSP%";

/** 构建（或开发服务器）处理 index.html 时填入 CSP。占位符不存在就报错：宁可构建失败，也不能发出一个没有 CSP 的界面。 */
export function applyCsp(html: string, dev: boolean): string {
  if (!html.includes(CSP_PLACEHOLDER)) throw new Error(`index.html has no ${CSP_PLACEHOLDER} placeholder`);
  return html.replace(CSP_PLACEHOLDER, dev ? DEV_CSP : PROD_CSP);
}
