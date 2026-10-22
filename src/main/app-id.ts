/**
 * 应用标识：Windows 通知的 AppUserModelID，也是 electron-builder 的 appId（electron-builder.yml，测试保证两者相同）。
 * 发布第一个版本之后不要再改：Windows 的开始菜单快捷方式、通知和开机自启都按它识别 Butler。
 */
export const APP_ID = "io.github.yul761.butler";
