import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * 设计文档 7.1：个人 LLM API 的网络请求只能从 PrivacyGateway（src/main/gateway/）发出。
 * 其他文件不能用浏览器 / Node 的网络 API，也不能 import 网络模块、HTTP 客户端、LLM SDK 或 Electron 的 net。
 * src/main/egress-lint.test.ts 用一段违规代码验证这些规则真的生效。
 */
const EGRESS_DIR = "src/main/gateway/**";
const EGRESS_MESSAGE = "网络请求只能在 src/main/gateway/ 里发（设计文档 7.1：PrivacyGateway 是唯一出口）。";
const NETWORK_BUILTINS = ["http", "https", "http2", "net", "tls", "dgram", "dns"];
const NETWORK_PACKAGES = [
  "undici", "node-fetch", "cross-fetch", "isomorphic-fetch", "axios", "got", "ky", "superagent", "request", "needle", "ws",
  "openai", "@anthropic-ai/sdk", "@google/generative-ai", "@google/genai", "@mistralai/mistralai", "cohere-ai", "groq-sdk", "ollama", "ai",
];
const NETWORK_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport"];
/** 动态 import / require 的模块名（esquery 的正则里不能有 /）。 */
const DYNAMIC_MODULES = `/^(node:)?(${NETWORK_BUILTINS.join("|")}|undici|axios|got|openai|ws)$/`;

const egressRules = {
  "no-restricted-imports": [
    "error",
    {
      paths: [
        ...NETWORK_BUILTINS.flatMap((m) => [m, `node:${m}`]).map((name) => ({ name, message: EGRESS_MESSAGE })),
        ...NETWORK_PACKAGES.map((name) => ({ name, message: EGRESS_MESSAGE })),
        { name: "electron", importNames: ["net", "netLog"], message: EGRESS_MESSAGE },
      ],
      patterns: [{ group: ["@anthropic-ai/*", "@ai-sdk/*", "@langchain/*", "langchain", "langchain/*", "openai/*", "undici/*"], message: EGRESS_MESSAGE }],
    },
  ],
  "no-restricted-globals": ["error", ...NETWORK_GLOBALS.map((name) => ({ name, message: EGRESS_MESSAGE }))],
  "no-restricted-properties": [
    "error",
    ...["globalThis", "window", "self", "global"].flatMap((object) => NETWORK_GLOBALS.map((property) => ({ object, property, message: EGRESS_MESSAGE }))),
    { object: "navigator", property: "sendBeacon", message: EGRESS_MESSAGE },
  ],
  "no-restricted-syntax": [
    "error",
    { selector: `ImportExpression[source.value=${DYNAMIC_MODULES}]`, message: EGRESS_MESSAGE },
    { selector: `CallExpression[callee.name="require"][arguments.0.value=${DYNAMIC_MODULES}]`, message: EGRESS_MESSAGE },
  ],
};

export default tseslint.config(
  { ignores: ["out/**", "build/**", "dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  { files: ["**/*.{ts,tsx,js,mjs,cjs}"], rules: egressRules },
  // 唯一出口：只有 gateway 目录可以联网。
  { files: [EGRESS_DIR], rules: Object.fromEntries(Object.keys(egressRules).map((rule) => [rule, "off"])) },
);
