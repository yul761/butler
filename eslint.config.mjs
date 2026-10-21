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
/** 能绕过静态检查去拿到任意模块的入口，同样只允许在 gateway 里。 */
const LOADER_BUILTINS = ["module"];
/** Electron 里能联网的对象。 */
const ELECTRON_NETWORK = ["net", "session", "autoUpdater", "netLog"];
const NETWORK_PACKAGES = [
  "undici", "node-fetch", "cross-fetch", "isomorphic-fetch", "axios", "got", "ky", "superagent", "request", "needle", "ws",
  "openai", "@anthropic-ai/sdk", "@google/generative-ai", "@google/genai", "@mistralai/mistralai", "cohere-ai", "groq-sdk", "ollama", "ai",
  "electron-updater", "https-proxy-agent", "socket.io-client", "@modelcontextprotocol/sdk",
];
const NETWORK_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "RTCPeerConnection"];
/** 动态 import / require 的模块名（esquery 的正则里不能有 /）。 */
const BANNED_BUILTINS = [...NETWORK_BUILTINS, ...LOADER_BUILTINS];
const DYNAMIC_MODULES = `/^(node:)?(${BANNED_BUILTINS.join("|")}|undici|axios|got|openai|ws|electron-updater|socket.io-client|https-proxy-agent)(\\/.*)?$/`;
const ELECTRON_NET_NAMES = `/^(${ELECTRON_NETWORK.join("|")})$/`;

const egressRules = {
  "no-restricted-imports": [
    "error",
    {
      paths: [
        ...BANNED_BUILTINS.flatMap((m) => [m, `node:${m}`]).map((name) => ({ name, message: EGRESS_MESSAGE })),
        ...NETWORK_PACKAGES.map((name) => ({ name, message: EGRESS_MESSAGE })),
        { name: "electron", importNames: ELECTRON_NETWORK, message: EGRESS_MESSAGE },
      ],
      patterns: [{ group: [...BANNED_BUILTINS.flatMap((m) => [`${m}/*`, `node:${m}/*`]), "@sentry/*", "@modelcontextprotocol/*", "electron-updater/*", "socket.io-client/*", "@anthropic-ai/*", "@ai-sdk/*", "@langchain/*", "langchain", "langchain/*", "openai/*", "undici/*"], message: EGRESS_MESSAGE }],
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
    { selector: `TSExternalModuleReference[expression.value=${DYNAMIC_MODULES}]`, message: EGRESS_MESSAGE },
    // 不能用变量 / 模板字符串 / createRequire 绕过上面的字面量检查。
    { selector: 'CallExpression[callee.name="require"][arguments.0.type!="Literal"]', message: EGRESS_MESSAGE },
    { selector: 'CallExpression[callee.name="require"][arguments.length!=1]', message: EGRESS_MESSAGE },
    { selector: 'ImportExpression[source.type!="Literal"]', message: EGRESS_MESSAGE },
    { selector: 'MemberExpression[object.name="module"][property.name="require"]', message: EGRESS_MESSAGE },
    { selector: 'CallExpression[callee.name="createRequire"]', message: EGRESS_MESSAGE },
    { selector: 'CallExpression[callee.property.name=/^(getBuiltinModule|binding|_linkedBinding|dlopen)$/]', message: EGRESS_MESSAGE },
    // Electron：只允许具名 import 且不含联网对象；默认 / 命名空间 import、require("electron")、import("electron") 都不行。
    { selector: 'ImportDeclaration[source.value="electron"] :matches(ImportDefaultSpecifier, ImportNamespaceSpecifier)', message: EGRESS_MESSAGE },
    { selector: `ImportDeclaration[source.value="electron"] ImportSpecifier[imported.name=${ELECTRON_NET_NAMES}]`, message: EGRESS_MESSAGE },
    { selector: 'ImportDeclaration[source.value="electron"] ImportSpecifier[imported.name="default"]', message: EGRESS_MESSAGE },
    { selector: 'CallExpression[callee.name="require"][arguments.0.value="electron"]', message: EGRESS_MESSAGE },
    { selector: 'ImportExpression[source.value="electron"]', message: EGRESS_MESSAGE },
    { selector: 'TSExternalModuleReference[expression.value="electron"]', message: EGRESS_MESSAGE },
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
