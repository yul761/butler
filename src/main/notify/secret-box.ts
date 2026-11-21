import { safeStorage } from "electron";

/** 系统加密存储。生产环境是 Electron safeStorage（electronSecretBox），测试用 testing/fake-secret-box。webhook 地址只以它的密文落盘。 */
export interface SecretBox {
  available(): boolean;
  encrypt(plain: string): Uint8Array;
  decrypt(data: Uint8Array): string;
}

/** Linux 没有钥匙串时 Electron 会退回 "basic_text"（明文），这种情况一律当作不可用。 */
function isPlaintextBackend(): boolean {
  const fn = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend;
  try {
    return typeof fn === "function" && fn.call(safeStorage) === "basic_text";
  } catch {
    return false;
  }
}

/** Electron safeStorage：macOS 用钥匙串，Windows 用 DPAPI。只能在 app ready 之后使用。 */
export const electronSecretBox: SecretBox = {
  available: () => safeStorage.isEncryptionAvailable() && !isPlaintextBackend(),
  encrypt: (plain) => new Uint8Array(safeStorage.encryptString(plain)),
  decrypt: (data) => safeStorage.decryptString(Buffer.from(data)),
};
