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
