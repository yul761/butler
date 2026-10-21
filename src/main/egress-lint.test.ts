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
};

async function egressCount(source: string, filePath: string): Promise<number> {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.filter((m) => m.ruleId !== null && EGRESS_RULES.includes(m.ruleId)).length;
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
