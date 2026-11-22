// 终端里点的链接（BTL-257）：xterm 的 OSC 8 超链接和普通文本里认出来的 URL，都交给系统浏览器打开。
// 只放行 http / https（不带用户名、密码）；file:、javascript:、自定义协议等一律拒绝并记日志（终端里的内容来自 agent 和它跑的命令，不可信）。

/** 链接最长多少个字符：超过就拒绝，不截断（截断后的链接会打开别的地方）。 */
export const EXTERNAL_LINK_MAX = 8192;

const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/** 解析一次，能交给浏览器就返回解析后的 href，否则 null。 */
export function safeExternalUrl(url: string): string | null {
  if (url.length === 0 || url.length > EXTERNAL_LINK_MAX) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(u.protocol) || u.hostname === "") return null;
  // https://github.com@evil.example/ 看着像 github，其实去 evil.example：带用户名或密码的一律不开。
  if (u.username !== "" || u.password !== "") return null;
  return u.href;
}

export type LinkOpenResult = { ok: true } | { ok: false; reason: "bad_url" };

/** 写进日志的样子：只有 scheme 和主机（路径、查询串、用户名密码里可能带 token），解析不了就只说解析不了。 */
function forLog(url: string): string {
  try {
    const u = new URL(url);
    return u.host ? `${u.protocol}//${u.host}` : u.protocol;
  } catch {
    return `unparseable (${url.length} chars)`;
  }
}

/**
 * 在系统浏览器里打开一个链接：先过 safeExternalUrl，交给浏览器的是检查过的那次解析的 href，不是原始输入。
 * 不允许的记一笔日志、返回 bad_url；openExternal 失败（没有浏览器、系统拒绝）也只记日志。
 */
export function openExternalLink(
  url: string,
  d: {
    openExternal: (url: string) => void | Promise<void>;
    log: (msg: string, e?: unknown) => void;
  },
): LinkOpenResult {
  const href = safeExternalUrl(url);
  if (!href) {
    d.log(`refused to open link (only http/https without credentials): ${forLog(url)}`);
    return { ok: false, reason: "bad_url" };
  }
  const failed = (e: unknown) => d.log(`opening a link on ${forLog(href)} failed`, e);
  try {
    void d.openExternal(href)?.catch(failed);
  } catch (e) {
    failed(e);
  }
  return { ok: true };
}
