import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Shipherd 自己不往外发网络请求（BTL-243 拿掉了个人 LLM API 和 PrivacyGateway）。
 * 所有源码都不能用浏览器 / Node 的网络 API，也不能 import 网络模块、HTTP 客户端、LLM SDK 或 Electron 的 net。没有目录例外，
 * 只有三个文件各放开一小块（见 ALLOWANCES）。src/main/egress-lint.test.ts 用一段违规代码验证这些规则真的生效。
 */
const EGRESS_MESSAGE = "Shipherd 不往外发网络请求（BTL-243）。唯一的出口是 src/main/notify/webhook.ts（对外动作 push_notification）。";
const NETWORK_BUILTINS = ["http", "https", "http2", "net", "tls", "dgram", "dns"];
/** 能绕过静态检查去拿到任意模块的入口，同样禁止。 */
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
 * 只有这几处能用它：主进程的适配层 src/main/memory/statecore.ts（环境变量由 statecoreEnv() 生成，从不给模型）、
 * 它所在目录的测试，以及给 claude 挂载的 MCP 入口 memory-mcp/entry.ts 和共享 MCP 的入口 memory-mcp/hub-entry.ts（都先清掉环境变量里的 key）。
 * 见计划 4 Ruling R1；hub 见 WS-M 设计 §8，它的契约测试要和真的 statecore-mcp 比。
 */
const STATECORE_MESSAGE = "StateCore 只能经 src/main/memory/statecore.ts、memory-mcp/entry.ts 或 memory-mcp/hub-entry.ts 使用（计划 4 R1：StateCore 不能拿到模型 key，也不能自己联网）。";
const STATECORE_MODULE = "/^statecore-mcp(\\/.*)?$/";
/** 动态 import / require / import = 的 statecore-mcp：报 StateCore 的提示，而不是出网的提示。 */
const STATECORE_SYNTAX = [
  { selector: `ImportExpression[source.value=${STATECORE_MODULE}]`, message: STATECORE_MESSAGE },
  { selector: `CallExpression[callee.name="require"][arguments.0.value=${STATECORE_MODULE}]`, message: STATECORE_MESSAGE },
  { selector: `TSExternalModuleReference[expression.value=${STATECORE_MODULE}]`, message: STATECORE_MESSAGE },
  // 模板字符串写法（没有表达式也一样）：开头是 statecore-mcp 就按 StateCore 报。
  { selector: 'ImportExpression > TemplateLiteral.source[quasis.0.value.raw=/^statecore-mcp/]', message: STATECORE_MESSAGE },
  { selector: 'CallExpression[callee.name="require"] > TemplateLiteral.arguments[quasis.0.value.raw=/^statecore-mcp/]', message: STATECORE_MESSAGE },
];
const STATECORE_ENTRY_FILES = ["src/main/memory/statecore.ts", "memory-mcp/entry.ts", "memory-mcp/hub-entry.ts"];
const STATECORE_TEST_FILES = ["src/main/memory/**/*.test.ts", "memory-mcp/hub-contract.test.ts"];
/**
 * 假 claude 像 Claude Code 一样经 HTTP 调共享 MCP（WS-M H）：只有它能用 node:http，而且只连 127.0.0.1 上的 hub。
 * 它只在 E2E 里跑，不进安装包。
 */
const FAKE_CLAUDE_FILES = ["e2e/fake-claude/fake-claude.cjs"];

/**
 * 测试用的本机记录器（loopback-recorder）能开 HTTP 服务、发 HTTP 请求：只有测试文件能 import 它。
 * 非测试文件 import / re-export 任何 testing/ 下的东西都不行，任何路径写法的 loopback-recorder 也不行
 * （./loopback-recorder、../testing/./loopback-recorder 这类绕法一样被拦）。
 */
const TEST_ONLY_MESSAGE = "src/main/testing/ 下的文件只给测试用（BTL-243）。";
const TEST_ONLY_RE = "(^|/)(testing/|loopback-recorder(\\.[cm]?[jt]sx?)?$)";
const TEST_ONLY_SEL = "/(^|\\/)(testing\\/|loopback-recorder(\\.[cm]?[jt]sx?)?$)/";

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
    ...STATECORE_SYNTAX,
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

/** 非测试文件：在出口规则之上，再禁止 import / require 测试用的记录器（相对路径或别名都算）。 */
const [, egressImportOptions] = egressRules["no-restricted-imports"];
const productionRules = {
  ...egressRules,
  "no-restricted-imports": [
    "error",
    { ...egressImportOptions, patterns: [...egressImportOptions.patterns, { regex: TEST_ONLY_RE, message: TEST_ONLY_MESSAGE }] },
  ],
  "no-restricted-syntax": [
    ...egressRules["no-restricted-syntax"],
    { selector: `ImportExpression[source.value=${TEST_ONLY_SEL}]`, message: TEST_ONLY_MESSAGE },
    { selector: `CallExpression[callee.name="require"][arguments.0.value=${TEST_ONLY_SEL}]`, message: TEST_ONLY_MESSAGE },
    { selector: `TSExternalModuleReference[expression.value=${TEST_ONLY_SEL}]`, message: TEST_ONLY_MESSAGE },
  ],
};

/**
 * 给单个文件放开一小块（BTL-243），其余规则一条不少：
 * - http：node:http（和 http）只能具名 import 这几个名字，默认 / 命名空间 import、require、import() 照旧被拦；
 * - electron：从 "electron" 具名 import 这几个联网对象；
 * - globals：可以用这几个全局（只是裸名字，globalThis.fetch 这种照旧被拦）。
 */
function allowing(rules, { http = [], electron = [], globals = [] }) {
  const [level, options] = rules["no-restricted-imports"];
  const paths = options.paths.map((p) => {
    if (http.length && (p.name === "http" || p.name === "node:http")) return { name: p.name, allowImportNames: http, message: p.message };
    if (electron.length && p.name === "electron") return { ...p, importNames: p.importNames.filter((n) => !electron.includes(n)) };
    return p;
  });
  const electronSel = `ImportDeclaration[source.value=${ELECTRON_MODULE}] ImportSpecifier[imported.name=${ELECTRON_NET_NAMES}]`;
  const rest = ELECTRON_NETWORK.filter((n) => !electron.includes(n));
  const syntax = rules["no-restricted-syntax"].map((r) =>
    electron.length && typeof r === "object" && r.selector === electronSel
      // "electron" 本身只放开给的名字；electron/main 这类子路径一个都不放开。
      ? { ...r, selector: `:matches(ImportDeclaration[source.value="electron"] ImportSpecifier[imported.name=/^(${rest.join("|")})$/], ImportDeclaration[source.value=/^electron\\/.+$/] ImportSpecifier[imported.name=${ELECTRON_NET_NAMES}])` }
      : r,
  );
  const [gLevel, ...gList] = rules["no-restricted-globals"];
  return {
    ...rules,
    "no-restricted-imports": [level, { ...options, paths }],
    "no-restricted-globals": [gLevel, ...gList.filter((g) => !globals.includes(g.name))],
    "no-restricted-syntax": syntax,
  };
}

/** 唯一的三处放行。每一处为什么需要见文件头的注释；改这里要同时改 egress-lint.test.ts。 */
const ALLOWANCES = [
  // 对外动作 push_notification 的 webhook：Electron 的 net.fetch（单元测试里退回全局 fetch）。开关默认关，每次都记审计。
  { files: ["src/main/notify/webhook.ts"], allow: { electron: ["net"], globals: ["fetch"] } },
  // 共享 MCP 在 127.0.0.1 上的监听：只收本机 claude 的请求，不往外发。
  { files: ["memory-mcp/loopback-http.ts"], allow: { http: ["createServer", "IncomingMessage", "ServerResponse"] } },
  // 测试用的本机记录器：只在 127.0.0.1 上收发。只有测试能 import 它（productionRules）。
  { files: ["src/main/testing/loopback-recorder.ts"], allow: { http: ["createServer", "request", "IncomingHttpHeaders"] } },
];

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

/** 去掉 http / node:http 的 import 限制（只给 FAKE_CLAUDE_FILES 用）。其余网络模块、fetch 照旧被拦。 */
function withoutHttp(rules) {
  const [level, options] = rules["no-restricted-imports"];
  return {
    ...rules,
    "no-restricted-imports": [level, { ...options, paths: options.paths.filter((p) => p.name !== "http" && p.name !== "node:http") }],
    "no-restricted-syntax": [
      ...rules["no-restricted-syntax"].slice(0, 1),
      ...rules["no-restricted-syntax"].slice(1).filter((r) => !(typeof r === "object" && r.selector === `CallExpression[callee.name="require"][arguments.0.value=${DYNAMIC_MODULES}]`)),
      { selector: `CallExpression[callee.name="require"][arguments.0.value=${DYNAMIC_MODULES}]:not([arguments.0.value=/^(node:)?http$/])`, message: EGRESS_MESSAGE },
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
  // CommonJS 的脚本（electron-builder 的 afterPack、E2E 的假 claude）：Node 的全局变量，允许 require。
  {
    files: ["scripts/**/*.cjs", "e2e/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { require: "readonly", module: "writable", exports: "writable", process: "readonly", console: "readonly", __dirname: "readonly", Buffer: "readonly", setTimeout: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // 计划 3 遗留：eval / new Function / 字符串 setTimeout 能在运行时拼出任何代码，出口规则看不到。
  // no-implied-eval 只认声明过的全局：这里声明 setTimeout / setInterval，否则字符串形式的定时器抓不到。
  {
    files: SOURCE_FILES,
    languageOptions: { globals: { setTimeout: "readonly", setInterval: "readonly" } },
    rules: { "no-eval": "error", "no-new-func": "error", "no-implied-eval": "error" },
  },
  { files: SOURCE_FILES, rules: productionRules },
  // 测试文件可以用测试记录器，但自己仍然不能联网。
  { files: TEST_FILES, rules: egressRules },
  ...ALLOWANCES.map(({ files, allow }) => ({ files, rules: allowing(productionRules, allow) })),
  // StateCore 的入口和适配层的测试（计划 4 R1）。
  { files: STATECORE_ENTRY_FILES, rules: withoutStatecore(productionRules) },
  { files: STATECORE_TEST_FILES, rules: withoutStatecore(egressRules) },
  { files: FAKE_CLAUDE_FILES, rules: withoutHttp(productionRules) },
);
