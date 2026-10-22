/** 测试用：npm / pnpm 在 Windows 上生成的 claude.cmd 原样内容（换行是 CRLF）。 */

/** npm 的 cmd-shim 生成的 claude.cmd（换行是 CRLF）。 */
export const NPM_SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join("\r\n");

/** pnpm 生成的 claude.cmd。 */
export const PNPM_SHIM = [
  "@SETLOCAL",
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*',
  ") ELSE (",
  "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
  '  node  "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*',
  ")",
].join("\r\n");

/** 老版本 npm（cmd-shim 2.x / 3.x）生成的 claude.cmd。 */
export const OLD_NPM_SHIM = [
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ") ELSE (",
  "  @SETLOCAL",
  "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
  '  node  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ")",
].join("\r\n");

/** cmd-shim 给非 JS 入口（原生可执行文件）生成的 shim：不经 node，认不出来。 */
export const NATIVE_TARGET_SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0",
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
].join("\r\n");
