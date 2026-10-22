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

describe("egress lint rule (design 7.1: PrivacyGateway is the only exit)", () => {
  it("rejects every network API outside the gateway, in main, renderer, shared and hook code", async () => {
    for (const file of ["src/main/brief/egress-probe.ts", "src/renderer/src/egress-probe.tsx", "src/shared/egress-probe.ts", "hook/egress-probe.ts"]) {
      const messages = await egressMessages(file);
      expect(new Set(messages.map((m) => m.line)), file).toEqual(new Set([1, 2, 3, 4, 5, 7, 8, 9]));
      expect(messages.every((m) => m.severity === 2), file).toBe(true);
    }
  }, 60_000);

  it("allows them inside src/main/gateway/", async () => {
    expect(await egressMessages("src/main/gateway/egress-probe.ts")).toEqual([]);
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

/** 每种出网写法单独一行：在 src/main 里必须被拦，在 src/main/gateway 里必须放行。 */
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
  // gateway 里“只能用字面量模块名”是另一条规则（给 StateCore 兜底），不算出网规则。
  return result.messages.filter((m) => m.ruleId !== null && EGRESS_RULES.includes(m.ruleId) && !m.message.includes("字面量模块名")).length;
}

describe("egress lint rule: every form", () => {
  for (const [name, source] of Object.entries(FORMS)) {
    it(`${name}: flagged in src/main, allowed in src/main/gateway`, async () => {
      expect(await egressCount(source, "src/main/brief/probe.ts"), "outside").toBeGreaterThan(0);
      expect(await egressCount(source, "src/main/gateway/probe.ts"), "gateway").toBe(0);
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
    it(`.${ext}: flagged outside the gateway, allowed inside`, async () => {
      const eslint = new ESLint({ cwd: root });
      expect(await eslint.isPathIgnored(`src/main/brief/probe.${ext}`)).toBe(false);
      const [result] = await eslint.lintText(source, { filePath: `src/main/brief/probe.${ext}` });
      const lines = result.messages.filter((m) => m.ruleId !== null && EGRESS_RULES.includes(m.ruleId)).map((m) => m.line);
      expect(new Set(lines)).toEqual(new Set([1, 2]));
      expect(await egressCount(source, `src/main/gateway/probe.${ext}`)).toBe(0);
    }, 60_000);
  }
});

/** gateway 的内部模块（直接发请求的 provider、假服务器 testing、假名化 / 扫描 / 投影 / 提示词）只能在 gateway 里用。 */
describe("egress lint rule: gateway internals stay inside the gateway", () => {
  const INTERNAL = ["provider", "testing", "pseudonym", "scanner", "projection", "narrative"];
  const PUBLIC = ["gateway", "key-store", "safe-storage", "status", "types", "budget", "statecore-env"];
  const forms = (m: string) => [
    `import { x } from "../gateway/${m}"; export default x;`,
    `import { x } from "./gateway/${m}.js"; export default x;`,
    `import { x } from "@main/gateway/${m}"; export default x;`,
    `import type { X } from "../gateway/${m}"; export type Y = X;`,
    `export { x } from "../gateway/${m}";`,
    `export * from "../../main/gateway/${m}";`,
    `export const x = require("../gateway/${m}");`,
    `export const x = import("../gateway/${m}");`,
    `import x = require("../gateway/${m}"); export default x;`,
  ];

  it("flags chatCompletion from ../gateway/provider in src/main/brief, not in src/main/gateway", async () => {
    const source = 'import { chatCompletion } from "../gateway/provider";\nexport const f = chatCompletion;';
    expect(await egressCount(source, "src/main/brief/x.ts")).toBeGreaterThan(0);
    expect(await egressCount(source, "src/main/gateway/x.ts")).toBe(0);
  }, 60_000);

  it("flags every internal module in every import form outside the gateway", async () => {
    for (const m of INTERNAL) {
      for (const source of forms(m)) {
        expect(await egressCount(source, "src/main/brief/x.ts"), source).toBeGreaterThan(0);
        expect(await egressCount(source, "src/renderer/src/x.tsx"), source).toBeGreaterThan(0);
        expect(await egressCount(source, "src/main/gateway/x.ts"), source).toBe(0);
      }
    }
  }, 60_000);

  it("allows the gateway's public modules from anywhere", async () => {
    for (const m of PUBLIC) {
      for (const source of forms(m).slice(0, 5)) expect(await egressCount(source, "src/main/brief/x.ts"), source).toBe(0);
    }
    // 名字相近但不是内部模块的不受影响。
    expect(await egressCount('import { x } from "../gateway/provider-names"; export default x;', "src/main/brief/x.ts")).toBe(0);
    expect(await egressCount('import { x } from "./narrative"; export default x;', "src/main/brief/x.ts")).toBe(0);
  }, 60_000);

  it("exempts test files, which still may not reach the network themselves", async () => {
    for (const file of ["src/main/brief/x.test.ts", "src/renderer/src/x.test.tsx"]) {
      for (const m of INTERNAL) expect(await egressCount(forms(m)[0], file), `${file} ${m}`).toBe(0);
      expect(await egressCount('import https from "node:https"; export default https;', file), file).toBeGreaterThan(0);
      expect(await egressCount('fetch("https://x");', file), file).toBeGreaterThan(0);
    }
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
    for (const file of ["src/main/brief/x.ts", "src/main/memory/memory-service.ts", "src/renderer/src/x.tsx", "hook/x.ts", "memory-mcp/clean-env.ts", "src/main/brief/x.test.ts", "src/main/gateway/x.ts", "src/main/gateway/x.test.ts"]) {
      expect((await statecoreMessages(file)).length, file).toBeGreaterThan(0);
    }
    expect((await statecoreMessages("src/main/brief/x.ts", 'import "statecore-mcp";\n')).length).toBeGreaterThan(0);
    expect((await statecoreMessages("src/main/brief/x.ts", 'export const m = import("statecore-mcp/lib");\n')).length).toBeGreaterThan(0);
    for (const file of ["src/main/brief/x.ts", "src/main/gateway/x.ts", "src/main/memory/statecore.ts"]) {
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

  it("catches template-literal and variable specifiers in the gateway, and reports template literals elsewhere as StateCore", async () => {
    for (const text of [
      'export const m = import(`statecore-mcp/lib`);\n',
      'const n = "statecore-mcp/lib";\nexport const m = import(n);\n',
      'const n = "statecore-mcp/lib";\nexport const m = require(n);\n',
      'export const m = require(`statecore-mcp`);\n',
    ]) {
      expect((await statecoreMessages("src/main/gateway/x.ts", text)).length, text).toBeGreaterThan(0);
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
    it(`${name}: flagged in main, gateway, renderer and hook code`, async () => {
      const eslint = new ESLint({ cwd: root });
      for (const file of ["src/main/brief/x.ts", "src/main/gateway/x.ts", "src/renderer/src/x.tsx", "hook/x.ts"]) {
        const [r] = await eslint.lintText(code, { filePath: file });
        expect(r.messages.filter((m) => RULES.includes(m.ruleId ?? "")).length, `${name} ${file}`).toBeGreaterThan(0);
      }
    }, 60_000);
  }
});
