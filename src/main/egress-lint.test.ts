import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const EGRESS_RULES = ["no-restricted-imports", "no-restricted-globals", "no-restricted-properties", "no-restricted-syntax"];

/** 每一行都是一种出网方式（第 6、10 行除外）。 */
const PROBE = [
  'import http from "node:http";',
  'import { request } from "https";',
  'import { net } from "electron";',
  'import OpenAI from "openai";',
  'import { fetch as undiciFetch } from "undici";',
  "export async function leak(): Promise<unknown> {",
  '  await fetch("https://example.com");',
  '  await globalThis.fetch("https://example.com");',
  '  await import("node:net");',
  "  return [http, request, net, OpenAI, undiciFetch];",
  "}",
].join("\n");

async function egressMessages(filePath: string) {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(PROBE, { filePath });
  return result.messages.filter((m) => m.ruleId !== null && EGRESS_RULES.includes(m.ruleId));
}

describe("egress lint rule (BTL-243: Butler sends nothing out on its own)", () => {
  it("rejects every network API in main, renderer, shared, hook and MCP code, src/main/gateway/ included", async () => {
    for (const file of ["src/main/brief/egress-probe.ts", "src/renderer/src/egress-probe.tsx", "src/shared/egress-probe.ts", "hook/egress-probe.ts", "memory-mcp/egress-probe.ts", "src/main/gateway/egress-probe.ts", "src/main/notify/egress-probe.ts"]) {
      const messages = await egressMessages(file);
      expect(new Set(messages.map((m) => m.line)), file).toEqual(new Set([1, 2, 3, 4, 5, 7, 8, 9]));
      expect(messages.every((m) => m.severity === 2), file).toBe(true);
    }
  }, 60_000);

  it("gives the three allowed files only what each one needs", async () => {
    // webhook.ts：Electron net（第 3 行）和全局 fetch（第 7 行）；loopback-http.ts、loopback-recorder.ts：都没有。
    expect(new Set((await egressMessages("src/main/notify/webhook.ts")).map((m) => m.line))).toEqual(new Set([1, 2, 4, 5, 8, 9]));
    for (const file of ["memory-mcp/loopback-http.ts", "src/main/testing/loopback-recorder.ts"]) {
      expect(new Set((await egressMessages(file)).map((m) => m.line)), file).toEqual(new Set([1, 2, 3, 4, 5, 7, 8, 9]));
    }
  }, 60_000);

  it("is in the config every source file gets, so `pnpm lint` enforces it", async () => {
    const eslint = new ESLint({ cwd: root });
    for (const file of ["src/main/index.ts", "src/renderer/src/App.tsx"]) {
      const config = (await eslint.calculateConfigForFile(file)) as { rules?: Record<string, unknown> };
      for (const rule of EGRESS_RULES) {
        const entry = config.rules?.[rule];
        const severity = Array.isArray(entry) ? entry[0] : entry;
        expect([2, "error"], `${file} ${rule}`).toContain(severity);
      }
    }
  }, 60_000);
});

/** 每种出网写法单独一行：在 src/main 里哪儿都必须被拦（gateway 目录已经没有例外）。 */
const FORMS: Record<string, string> = {
  "require in a function": 'export function a(): unknown { return require("https"); }',
  "require of a banned subpath": 'require("node:https/foo");',
  "require with a variable": 'const n = "https"; require(n);',
  "require with a template": "require(`https`);",
  "module.require": 'module.require("https");',
  createRequire: 'import { createRequire } from "node:module"; export const r = createRequire(import.meta.url);',
  "import module": 'import m from "module"; export default m;',
  "import equals require": 'import h = require("https"); export default h;',
  "dns/promises": 'import { lookup } from "node:dns/promises"; export default lookup;',
  "dns/promises without prefix": 'import { lookup } from "dns/promises"; export default lookup;',
  "dynamic dns/promises": 'import("node:dns/promises");',
  "dynamic https subpath": 'import("https/x");',
  "dynamic import with a variable": 'const n = "https"; import(n);',
  "re-export": 'export * from "node:https";',
  http2: 'import h from "node:http2"; export default h;',
  tls: 'import h from "tls"; export default h;',
  dgram: 'import h from "node:dgram"; export default h;',
  dns: 'import h from "dns"; export default h;',
  net: 'import h from "net"; export default h;',
  "electron net": 'import { net } from "electron"; export default net;',
  "electron session": 'import { session } from "electron"; export default session;',
  "electron autoUpdater": 'import { autoUpdater } from "electron"; export default autoUpdater;',
  "electron netLog": 'import { netLog } from "electron"; export default netLog;',
  "electron default import": 'import electron from "electron"; export default electron.net;',
  "electron namespace import": 'import * as electron from "electron"; export default electron.net;',
  "electron require destructure": 'const { net } = require("electron"); export default net;',
  "electron dynamic import": 'import("electron");',
  "electron/main net": 'import { net } from "electron/main"; export default net;',
  "electron/renderer session": 'import { session } from "electron/renderer"; export default session;',
  "electron/common default": 'import e from "electron/common"; export default e;',
  "electron/main namespace": 'import * as e from "electron/main"; export default e;',
  "electron/main require": 'const { net } = require("electron/main"); export default net;',
  "export default from electron": 'export { default } from "electron";',
  "export net from electron/main": 'export { net } from "electron/main";',
  "export star from electron": 'export * from "electron";',
  "window.fetch": 'window.fetch("x");',
  "self.fetch": 'self.fetch("x");',
  "global.fetch": 'global.fetch("x");',
  "globalThis.fetch": 'globalThis.fetch("x");',
  XMLHttpRequest: "new XMLHttpRequest();",
  WebSocket: 'new WebSocket("wss://x");',
  EventSource: 'new EventSource("https://x");',
  RTCPeerConnection: "new RTCPeerConnection();",
  sendBeacon: 'navigator.sendBeacon("https://x");',
  sentry: 'import * as S from "@sentry/electron/main"; export default S;',
  "electron-updater": 'import { autoUpdater } from "electron-updater"; export default autoUpdater;',
  "https-proxy-agent": 'import { HttpsProxyAgent } from "https-proxy-agent"; export default HttpsProxyAgent;',
  "socket.io-client": 'import { io } from "socket.io-client"; export default io;',
  "mcp sdk": 'import { Client } from "@modelcontextprotocol/sdk/client/index.js"; export default Client;',
  ws: 'import W from "ws"; export default W;',
  "session.fetch": 'import type { BrowserWindow } from "electron"; export function a(w: BrowserWindow) { return w.webContents.session.fetch("https://x"); }',
  "session?.fetch": 'export function a(w: { session?: { fetch(u: string): void } }) { return w.session?.fetch("https://x"); }',
  'session["fetch"]': 'export function a(w: { session: { fetch(u: string): void } }) { return w.session["fetch"]("https://x"); }',
  downloadURL: 'import type { BrowserWindow } from "electron"; export function a(w: BrowserWindow) { w.webContents.downloadURL("https://x"); }',
  'downloadURL computed': 'export function a(w: Record<string, (u: string) => void>) { w["downloadURL"]("https://x"); }',
  "require.main.require": 'export const h = require.main.require("https");',
  "require.main?.require": 'export const h = require.main?.require("https");',
  "process.mainModule": 'export const h = process.mainModule?.require("https");',
  'process["mainModule"]': 'export const h = (process as any)["mainModule"].require("https");',
  "process.binding": 'export const b = process.binding("tcp_wrap");',
  'process["binding"]': 'export const b = (process as any)["binding"]("tcp_wrap");',
};

async function egressCount(source: string, filePath: string): Promise<number> {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.filter((m) => m.ruleId !== null && EGRESS_RULES.includes(m.ruleId)).length;
}

describe("egress lint rule: every form", () => {
  for (const [name, source] of Object.entries(FORMS)) {
    it(`${name}: flagged in src/main, src/main/gateway and the three allowed files`, async () => {
      for (const file of ["src/main/brief/probe.ts", "src/main/gateway/probe.ts", "src/main/notify/webhook.ts", "memory-mcp/loopback-http.ts", "src/main/testing/loopback-recorder.ts"]) {
        // webhook.ts 唯一放行的就是 electron 的具名 net。
        if (name === "electron net" && file.endsWith("webhook.ts")) continue;
        expect(await egressCount(source, file), file).toBeGreaterThan(0);
      }
    }, 60_000);
  }

  it("still allows process spawning, fs and Electron windows (not network egress)", async () => {
    const ok = [
      'import { spawn } from "node:child_process"; spawn("claude", []);',
      'import fs from "node:fs"; fs.readFileSync("x");',
      'import { BrowserWindow, dialog, shell } from "electron"; void [BrowserWindow, dialog, shell];',
      'const fs = require("node:fs"); fs.statSync("x");',
    ];
    for (const source of ok) expect(await egressCount(source, "src/main/brief/probe.ts"), source).toBe(0);
  }, 60_000);
});

/** 每个文件后缀都在规则覆盖范围内（.mts / .cts / .jsx 不能成为漏网之鱼）。 */
describe("egress lint rule: every source extension", () => {
  const source = 'import https from "node:https";\nexport const a = fetch("https://x");\nexport default https;';
  for (const ext of ["mts", "cts", "jsx", "mjs", "cjs", "js", "tsx"]) {
    it(`.${ext}: flagged everywhere`, async () => {
      const eslint = new ESLint({ cwd: root });
      for (const file of [`src/main/brief/probe.${ext}`, `src/main/gateway/probe.${ext}`]) {
        expect(await eslint.isPathIgnored(file)).toBe(false);
        const [result] = await eslint.lintText(source, { filePath: file });
        const lines = result.messages.filter((m) => m.ruleId !== null && EGRESS_RULES.includes(m.ruleId)).map((m) => m.line);
        expect(new Set(lines), file).toEqual(new Set([1, 2]));
      }
    }, 60_000);
  }
});

/** BTL-243：只有三个文件各有一小块放行，别的写法照样被拦。 */
describe("egress lint rule: the per-file allowances stay narrow", () => {
  const lint = (source: string, file: string) => egressCount(source, file);

  it("webhook.ts may use Electron net and the global fetch, nothing else", async () => {
    const file = "src/main/notify/webhook.ts";
    expect(await lint('import { net } from "electron";\nexport const f = (u: string) => (net?.fetch ? net.fetch(u) : fetch(u));', file)).toBe(0);
    expect(await lint('import { dialog } from "electron";\nexport default dialog;', file)).toBe(0);
    for (const bad of [
      'import { session } from "electron"; export default session;',
      'import { autoUpdater } from "electron"; export default autoUpdater;',
      'import electron from "electron"; export default electron.net;',
      'import { createServer } from "node:http"; export default createServer;',
      'import https from "node:https"; export default https;',
      'export const x = new WebSocket("wss://x");',
      'navigator.sendBeacon("https://x");',
    ]) expect(await lint(bad, file), bad).toBeGreaterThan(0);
  }, 60_000);

  it("loopback-http.ts may take only createServer and two types from node:http", async () => {
    const file = "memory-mcp/loopback-http.ts";
    expect(await lint('import { createServer, type IncomingMessage, type ServerResponse } from "node:http";\nexport const s = createServer();\nexport type A = [IncomingMessage, ServerResponse];', file)).toBe(0);
    for (const bad of [
      'import { request } from "node:http"; export default request;',
      'import { get } from "node:http"; export default get;',
      'import http from "node:http"; export default http;',
      'import * as http from "node:http"; export default http;',
      'export const h = require("node:http");',
      'import("node:http");',
      'import { createServer } from "node:https"; export default createServer;',
      'import { net } from "electron"; export default net;',
      'fetch("http://127.0.0.1/");',
    ]) expect(await lint(bad, file), bad).toBeGreaterThan(0);
  }, 60_000);

  it("loopback-recorder.ts may take only createServer, request and a header type from node:http", async () => {
    const file = "src/main/testing/loopback-recorder.ts";
    expect(await lint('import { createServer, request, type IncomingHttpHeaders } from "node:http";\nexport const a = [createServer, request];\nexport type H = IncomingHttpHeaders;', file)).toBe(0);
    for (const bad of [
      'import { get } from "node:http"; export default get;',
      'import http from "node:http"; export default http;',
      'import { request } from "node:https"; export default request;',
      'fetch("http://127.0.0.1/");',
    ]) expect(await lint(bad, file), bad).toBeGreaterThan(0);
  }, 60_000);

  it("other files get none of it, and only tests may import the recorder", async () => {
    for (const file of ["src/main/notify/notifier.ts", "memory-mcp/hub.ts", "src/main/testing/fake-secret-box.ts"]) {
      expect(await lint('import { createServer } from "node:http"; export default createServer;', file), file).toBeGreaterThan(0);
      expect(await lint('import { net } from "electron"; export default net;', file), file).toBeGreaterThan(0);
    }
    for (const source of [
      'import { postLoopback } from "../testing/loopback-recorder"; export default postLoopback;',
      'import { postLoopback } from "../src/main/testing/loopback-recorder.ts"; export default postLoopback;',
      'export const r = import("../testing/loopback-recorder");',
      'export const r = require("../testing/loopback-recorder");',
      'import { postLoopback } from "../testing/./loopback-recorder"; export default postLoopback;',
      'export { postLoopback } from "../testing/loopback-recorder";',
      'export * from "../testing/loopback-recorder";',
      'import { fakeSecretBox } from "../testing/fake-secret-box"; export default fakeSecretBox;',
    ]) {
      expect(await lint(source, "src/main/notify/notifier.ts"), source).toBeGreaterThan(0);
      expect(await lint(source, "src/main/notify/notifier.test.ts"), source).toBe(0);
    }
    // testing/ 里的其他文件也不能把记录器转出去给生产代码用。
    for (const source of [
      'export { postLoopback } from "./loopback-recorder";',
      'export * from "./loopback-recorder";',
      'import { postLoopback } from "./loopback-recorder.ts"; export default postLoopback;',
    ]) expect(await lint(source, "src/main/testing/fake-secret-box.ts"), source).toBeGreaterThan(0);
  }, 60_000);
});

describe("StateCore is reachable only through its two entry points (plan 4 R1)", () => {
  const probe = 'import { createEmbeddedBackend } from "statecore-mcp/lib";\nexport default createEmbeddedBackend;\n';
  async function statecoreMessages(filePath: string, text = probe) {
    const eslint = new ESLint({ cwd: root });
    const [result] = await eslint.lintText(text, { filePath });
    return result.messages.filter((m) => m.ruleId === "no-restricted-imports" || m.ruleId === "no-restricted-syntax");
  }

  it("flags statecore-mcp everywhere else, in every import form", async () => {
    for (const file of ["src/main/brief/x.ts", "src/main/memory/memory-service.ts", "src/renderer/src/x.tsx", "hook/x.ts", "memory-mcp/clean-env.ts", "memory-mcp/loopback-http.ts", "src/main/brief/x.test.ts", "src/main/notify/webhook.ts"]) {
      expect((await statecoreMessages(file)).length, file).toBeGreaterThan(0);
    }
    expect((await statecoreMessages("src/main/brief/x.ts", 'import "statecore-mcp";\n')).length).toBeGreaterThan(0);
    expect((await statecoreMessages("src/main/brief/x.ts", 'export const m = import("statecore-mcp/lib");\n')).length).toBeGreaterThan(0);
    for (const file of ["src/main/brief/x.ts", "src/main/notify/webhook.ts", "src/main/memory/statecore.ts"]) {
      for (const text of [
        'export const m = import("statecore-mcp/lib");\n',
        'const m = require("statecore-mcp");\n',
        'import m = require("statecore-mcp/lib");\nexport default m;\n',
        ...(file === "src/main/memory/statecore.ts" ? [] : ['export * from "statecore-mcp/lib";\n', 'import type { X } from "statecore-mcp/lib";\nexport type Y = X;\n']),
      ]) {
        const messages = await statecoreMessages(file, text);
        expect(messages.length, `${file}: ${text}`).toBeGreaterThan(0);
        expect(messages.every((m) => m.message.includes("StateCore")), `${file}: ${text}`).toBe(true);
      }
    }
  }, 60_000);

  it("catches template-literal and variable specifiers, and reports template literals as StateCore", async () => {
    for (const text of [
      'export const m = import(`statecore-mcp/lib`);\n',
      'const n = "statecore-mcp/lib";\nexport const m = import(n);\n',
      'const n = "statecore-mcp/lib";\nexport const m = require(n);\n',
      'export const m = require(`statecore-mcp`);\n',
    ]) {
      expect((await statecoreMessages("src/main/notify/webhook.ts", text)).length, text).toBeGreaterThan(0);
    }
    for (const text of ['export const m = import(`statecore-mcp/lib`);\n', 'export const m = require(`statecore-mcp`);\n']) {
      const messages = await statecoreMessages("src/main/brief/x.ts", text);
      expect(messages.some((m) => m.message.includes("StateCore")), text).toBe(true);
    }
  }, 60_000);

  it("allows it in the adapter, its tests and the MCP entry", async () => {
    for (const file of ["src/main/memory/statecore.ts", "src/main/memory/statecore.test.ts", "memory-mcp/entry.ts"]) {
      expect(await statecoreMessages(file), file).toEqual([]);
    }
    expect(await statecoreMessages("memory-mcp/entry.ts", 'import "./clean-env";\nimport "statecore-mcp";\n')).toEqual([]);
  }, 60_000);
});

describe("no eval or Function constructor anywhere (plan 3 residual)", () => {
  const FORMS: Record<string, string> = {
    eval: 'export const x = eval("1 + 1");',
    "new Function": 'export const f = new Function("return 1");',
    "Function call": 'export const f = Function("return 1");',
    "string setTimeout": 'setTimeout("doIt()", 10);',
  };
  const RULES = ["no-eval", "no-new-func", "no-implied-eval"];
  for (const [name, code] of Object.entries(FORMS)) {
    it(`${name}: flagged in main, renderer, hook and MCP code`, async () => {
      const eslint = new ESLint({ cwd: root });
      for (const file of ["src/main/brief/x.ts", "src/main/notify/webhook.ts", "src/renderer/src/x.tsx", "hook/x.ts", "memory-mcp/loopback-http.ts"]) {
        const [r] = await eslint.lintText(code, { filePath: file });
        expect(r.messages.filter((m) => RULES.includes(m.ruleId ?? "")).length, `${name} ${file}`).toBeGreaterThan(0);
      }
    }, 60_000);
  }
});
