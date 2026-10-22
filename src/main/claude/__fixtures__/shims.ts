/**
 * 测试专用（不要从应用代码 import）：Windows 上 npm / pnpm 生成的 claude.cmd，逐字节照抄（CRLF，结尾也有 CRLF）。
 * npm 的来自 npm 自带的 cmd-shim 8.0.0；pnpm 的来自 pnpm 9.15.0 的 generateCmdShim。
 */

const crlf = (lines: string[]): string => lines.map((l) => `${l}\r\n`).join("");

const NPM_HEAD = ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0"];
const NPM_PROG = ["", 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", ""];

/** npm（cmd-shim 8.0.0），JS 入口。 */
export const NPM_SHIM = crlf([
  ...NPM_HEAD, ...NPM_PROG,
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
]);

/** npm（cmd-shim 8.0.0），入口的 shebang 是 `#!/usr/bin/env -S node --no-warnings`。 */
export const NPM_FLAGS_SHIM = crlf([
  ...NPM_HEAD, ...NPM_PROG,
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" --no-warnings "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
]);

/** npm（cmd-shim 8.0.0），原生入口：claude-code 2.1.307 的 `"bin": {"claude": "bin/claude.exe"}`。 */
export const NPM_EXE_SHIM = crlf([...NPM_HEAD, '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*']);

/** 老版本 npm（cmd-shim 2.x / 3.x）。 */
export const OLD_NPM_SHIM = crlf([
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ") ELSE (",
  "  @SETLOCAL",
  "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
  '  node  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ")",
]);

const PNPM_NODE = (flags: string) => [
  '@IF EXIST "%~dp0\\node.exe" (',
  `  "%~dp0\\node.exe" ${flags} "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*`,
  ") ELSE (",
  "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
  `  node ${flags} "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*`,
  ")",
];

/** pnpm，最简单的形式（没有 NODE_PATH、没有固定 node）。 */
export const PNPM_SHIM = crlf(["@SETLOCAL", ...PNPM_NODE("")]);

/** pnpm 全局安装通常会写的形式：先设置 NODE_PATH。 */
export const PNPM_NODE_PATH = "D:\\pnpm\\global\\5\\node_modules\\.pnpm\\node_modules;D:\\pnpm\\global\\5\\node_modules";
export const PNPM_NODE_PATH_SHIM = crlf([
  "@SETLOCAL",
  "@IF NOT DEFINED NODE_PATH (",
  `  @SET "NODE_PATH=${PNPM_NODE_PATH}"`,
  ") ELSE (",
  `  @SET "NODE_PATH=${PNPM_NODE_PATH};%NODE_PATH%"`,
  ")",
  ...PNPM_NODE(""),
]);

/** pnpm 管理 node 时：shim 固定 node.exe 的绝对路径。 */
export const PNPM_PINNED_NODE = "C:\\Users\\John Smith\\AppData\\Local\\pnpm\\nodejs\\20.11.0\\node.exe";
export const PNPM_PINNED_SHIM = crlf(["@SETLOCAL", `@"${PNPM_PINNED_NODE}"  "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*`]);

/** pnpm，原生入口。 */
export const PNPM_EXE_SHIM = crlf(["@SETLOCAL", '@"%~dp0\\..\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*']);

/** pnpm，preserve-symlinks 打开时。 */
export const PNPM_SYMLINKS_SHIM = crlf(["@SETLOCAL", ...PNPM_NODE("--preserve-symlinks")]);

/** pnpm，prependToPath：shim 改了 PATH，直接启动做不到一样，认不出来。 */
export const PNPM_PATH_SHIM = crlf(["@SETLOCAL", '@SET "PATH=C:\\tools:%PATH%"', ...PNPM_NODE("")]);
