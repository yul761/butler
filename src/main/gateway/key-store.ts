import type { KeyState } from "../../shared/llm";
import type { SecretsRepo } from "../db/secrets-repo";
import { SettingError } from "../settings/settings-values";

export const API_KEY_SECRET = "llm_api_key";

/** 系统加密存储。生产环境是 Electron safeStorage（safe-storage.ts），测试用 fakeSecretBox。 */
export interface SecretBox {
  available(): boolean;
  encrypt(plain: string): Uint8Array;
  decrypt(data: Uint8Array): string;
}

/** 界面上显示的 key：•••• + 末 4 位；太短的 key 全部打码。 */
export function maskKey(key: string): string {
  return key.length >= 12 ? `••••${key.slice(-4)}` : "••••";
}

export interface KeyStoreDeps {
  secrets: SecretsRepo;
  box: SecretBox;
  now: () => number;
  log?: (msg: string, err?: unknown) => void;
}

/**
 * 个人 API key：只以密文落盘。解密只在主进程里、只给 gateway 用（get）；
 * IPC 只能返回 state()，完整的 key 保存之后永远不回到渲染进程。
 */
export class KeyStore {
  constructor(private readonly d: KeyStoreDeps) {}

  save(key: string): KeyState {
    const k = key.trim();
    // eslint-disable-next-line no-control-regex
    if (k.length < 8 || k.length > 512 || /[\s\u0000-\u001f\u007f]/.test(k)) {
      throw new SettingError("API key 格式不对：8–512 个字符，不能有空格或换行");
    }
    if (!this.d.box.available()) throw new SettingError("系统的加密存储不可用，Butler 不会以明文保存 key");
    let cipher: Uint8Array;
    try {
      cipher = this.d.box.encrypt(k);
    } catch {
      // 不转发底层错误：有的实现会把明文带进 message。
      throw new SettingError("系统的加密存储出错，key 没有保存");
    }
    this.d.secrets.set(API_KEY_SECRET, cipher, this.d.now());
    return this.state();
  }

  clear(): KeyState {
    this.d.secrets.delete(API_KEY_SECRET);
    return this.state();
  }

  /** 有没有保存过 key。只查数据库，不碰系统钥匙串（没配置时 gateway 不会去访问钥匙串）。 */
  saved(): boolean {
    return this.d.secrets.get(API_KEY_SECRET) !== null;
  }

  /** 只给 gateway 用。没有保存、或者解不开（钥匙串被重置、换了电脑）时为 null。 */
  get(): string | null {
    const data = this.d.secrets.get(API_KEY_SECRET);
    if (!data) return null;
    try {
      return this.d.box.decrypt(data);
    } catch {
      // 不记录错误对象：有的实现会把密文或明文片段带进 message。
      this.d.log?.("saved API key cannot be decrypted; it needs to be entered again");
      return null;
    }
  }

  state(): KeyState {
    const saved = this.saved();
    const key = saved ? this.get() : null;
    return { keySaved: saved, keyMasked: key ? maskKey(key) : null, keyUnreadable: saved && key === null, encryptionAvailable: this.d.box.available() };
  }
}
