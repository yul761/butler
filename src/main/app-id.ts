/**
 * 应用标识：Windows 通知的 AppUserModelID，也是 electron-builder 的 appId（electron-builder.yml，测试保证两者相同）。
 * 发布第一个版本之后不要再改：Windows 的开始菜单快捷方式、通知和开机自启都按它识别 Butler。
 */
export const APP_ID = "io.statecore.butler";

/** 只有 Windows 的通知需要 AppUserModelID。 */
export const shouldSetAppId = (platform: NodeJS.Platform): boolean => platform === "win32";
