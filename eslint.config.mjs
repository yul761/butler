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
const DYNAMIC_MODULES = `/^(node:)?(${BANNED_BUILTINS.join("|")}|undici|axios|got|openai|ws|electron-updater|socket.io-client|https-proxy-agent|statecore-mcp)(\\/.*)?$/`;
const ELECTRON_MODULE = "/^electron(\\/.*)?$/";
const ELECTRON_NET_NAMES = `/^(${ELECTRON_NETWORK.join("|")})$/`;
/** 能拿到模块加载器 / 原生绑定的属性（process.binding、process.mainModule……），点号和字符串下标都算。 */
const LOADER_PROPS = "/^(mainModule|binding|_linkedBinding|getBuiltinModule|dlopen)$/";
const memberNamed = (names) => `:matches([computed=false][property.name=${names}], [computed=true][property.value=${names}])`;
/** 规则覆盖的所有源码后缀。 */
const SOURCE_FILES = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"];
const TEST_FILES = ["**/*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"];

/**
 * StateCore（statecore-mcp）自带联网的 http 后端，还会按环境变量（FEATURE_LLM / MODEL_*）直接调用模型。
 * 只有这几处能用它：主进程的适配层 src/main/memory/statecore.ts（环境变量由 statecoreEnv() 生成，模型只能是 PrivacyGateway 给的）、
 * 它所在目录的测试，以及给 claude 挂载的 MCP 入口 memory-mcp/entry.ts（先清掉环境变量里的 key）。见计划 4 Ruling R1。
 */
const STATECORE_MESSAGE = "StateCore 只能经 src/main/memory/statecore.ts 或 memory-mcp/entry.ts 使用（计划 4 R1：模型 key 不能绕过 PrivacyGateway）。";
const STATECORE_ENTRY_FILES = ["src/main/memory/statecore.ts", "memory-mcp/entry.ts"];
const STATECORE_TEST_FILES = ["src/main/memory/**/*.test.ts"];

/**
 * gateway 的内部模块：直接发请求的 provider、测试用假服务器 testing，以及假名化 / 扫描 / 投影 / 提示词。
 * gateway 外面只能经 PrivacyGateway（gateway.ts）和 key-store、safe-storage、status、types、budget、statecore-env 这几个公开模块。
 * 测试文件不受这一条限制（其余出口规则照旧）。
 */
const GATEWAY_INTERNALS = ["provider", "testing", "pseudonym", "scanner", "projection", "narrative"];
const GATEWAY_INTERNAL_MESSAGE = "gateway 的内部模块只能在 src/main/gateway/ 里用，外面请经 PrivacyGateway（设计文档 7.1）。";
const GATEWAY_INTERNAL_RE = `(^|/)gateway/(${GATEWAY_INTERNALS.join("|")})(\\.[cm]?[jt]sx?)?$`;
const GATEWAY_INTERNAL_SEL = `/(^|\\/)gateway\\/(${GATEWAY_INTERNALS.join("|")})(\\.[cm]?[jt]sx?)?$/`;

const egressRules = {
  "no-restricted-imports": [
    "error",
    {
      paths: [
        ...BANNED_BUILTINS.flatMap((m) => [m, `node:${m}`]).map((name) => ({ name, message: EGRESS_MESSAGE })),
        ...NETWORK_PACKAGES.map((name) => ({ name, message: EGRESS_MESSAGE })),
        { name: "electron", importNames: ELECTRON_NETWORK, message: EGRESS_MESSAGE },
        { name: "statecore-mcp", message: STATECORE_MESSAGE },
      ],
      patterns: [
        { group: ["electron/*"], importNames: ELECTRON_NETWORK, message: EGRESS_MESSAGE },
        { group: [...BANNED_BUILTINS.flatMap((m) => [`${m}/*`, `node:${m}/*`]), "@sentry/*", "@modelcontextprotocol/*", "electron-updater/*", "socket.io-client/*", "@anthropic-ai/*", "@ai-sdk/*", "@langchain/*", "langchain", "langchain/*", "openai/*", "undici/*"], message: EGRESS_MESSAGE },
        { group: ["statecore-mcp/*"], message: STATECORE_MESSAGE },
      ],
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
    { selector: `MemberExpression${memberNamed(LOADER_PROPS)}`, message: EGRESS_MESSAGE },
    { selector: `MemberExpression[object.name="require"]${memberNamed('"main"')}`, message: EGRESS_MESSAGE },
    // Electron 里拿到的 session / webContents 也能直接联网。
    { selector: `MemberExpression[object.type="MemberExpression"]${memberNamed('"fetch"')}:matches([object.computed=false][object.property.name=/^(session|defaultSession)$/], [object.computed=true][object.property.value=/^(session|defaultSession)$/])`, message: EGRESS_MESSAGE },
    { selector: `MemberExpression${memberNamed('"downloadURL"')}`, message: EGRESS_MESSAGE },
    // Electron：只允许具名 import 且不含联网对象；默认 / 命名空间 import、require("electron")、import("electron") 都不行。
    { selector: `ImportDeclaration[source.value=${ELECTRON_MODULE}] :matches(ImportDefaultSpecifier, ImportNamespaceSpecifier)`, message: EGRESS_MESSAGE },
    { selector: `ImportDeclaration[source.value=${ELECTRON_MODULE}] ImportSpecifier[imported.name=${ELECTRON_NET_NAMES}]`, message: EGRESS_MESSAGE },
    { selector: `ExportNamedDeclaration[source.value=${ELECTRON_MODULE}]`, message: EGRESS_MESSAGE },
    { selector: `ExportAllDeclaration[source.value=${ELECTRON_MODULE}]`, message: EGRESS_MESSAGE },
    { selector: `ImportDeclaration[source.value=${ELECTRON_MODULE}] ImportSpecifier[imported.name="default"]`, message: EGRESS_MESSAGE },
    { selector: `CallExpression[callee.name="require"][arguments.0.value=${ELECTRON_MODULE}]`, message: EGRESS_MESSAGE },
    { selector: `ImportExpression[source.value=${ELECTRON_MODULE}]`, message: EGRESS_MESSAGE },
    { selector: `TSExternalModuleReference[expression.value=${ELECTRON_MODULE}]`, message: EGRESS_MESSAGE },
  ],
};

/** gateway 以外的非测试文件：在出口规则之上，再禁止 import / require gateway 的内部模块（相对路径或别名都算）。 */
const [, egressImportOptions] = egressRules["no-restricted-imports"];
const outsideGatewayRules = {
  ...egressRules,
  "no-restricted-imports": [
    "error",
    { ...egressImportOptions, patterns: [...egressImportOptions.patterns, { regex: GATEWAY_INTERNAL_RE, message: GATEWAY_INTERNAL_MESSAGE }] },
  ],
  "no-restricted-syntax": [
    ...egressRules["no-restricted-syntax"],
    { selector: `ImportExpression[source.value=${GATEWAY_INTERNAL_SEL}]`, message: GATEWAY_INTERNAL_MESSAGE },
    { selector: `CallExpression[callee.name="require"][arguments.0.value=${GATEWAY_INTERNAL_SEL}]`, message: GATEWAY_INTERNAL_MESSAGE },
    { selector: `TSExternalModuleReference[expression.value=${GATEWAY_INTERNAL_SEL}]`, message: GATEWAY_INTERNAL_MESSAGE },
  ],
};

/** 去掉 StateCore 那两条 import 限制（只给 STATECORE_ENTRY_FILES / STATECORE_TEST_FILES 用）。动态 import 仍然被拦。 */
function withoutStatecore(rules) {
  const [level, options] = rules["no-restricted-imports"];
  return {
    ...rules,
    "no-restricted-imports": [
      level,
      {
        ...options,
        paths: options.paths.filter((p) => p.message !== STATECORE_MESSAGE),
        patterns: options.patterns.filter((p) => p.message !== STATECORE_MESSAGE),
      },
    ],
  };
}

export default tseslint.config(
  { ignores: ["out/**", "build/**", "dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  { files: SOURCE_FILES, rules: outsideGatewayRules },
  // 测试文件可以用 gateway 的内部模块（假服务器等），但自己仍然不能联网。
  { files: TEST_FILES, rules: egressRules },
  // 唯一出口：只有 gateway 目录可以联网。
  { files: [EGRESS_DIR], rules: Object.fromEntries(Object.keys(egressRules).map((rule) => [rule, "off"])) },
  // StateCore 的两个入口和适配层的测试（计划 4 R1）。
  { files: STATECORE_ENTRY_FILES, rules: withoutStatecore(outsideGatewayRules) },
  { files: STATECORE_TEST_FILES, rules: withoutStatecore(egressRules) },
);
