import type { KeyState } from "../../shared/llm";
import type { SecretsRepo } from "../db/secrets-repo";
import { SettingError } from "../settings/settings-values";
import { M } from "../strings";

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

const KEY_FORMAT = /^[\x21-\x7e]{8,512}$/;

/**
 * 个人 API key：只以密文落盘。解密只在主进程里、只给 gateway 用（get）；
 * IPC 只能返回 state()，完整的 key 保存之后永远不回到渲染进程。
 */
export class KeyStore {
  private cache: { masked: string | null; unreadable: boolean } | null = null;
  /**
   * 系统加密存储可不可用。null = 还没查过。只在保存 key、或已经保存的 key 被解密时才去查：
   * 在 macOS 上一查就会访问钥匙串（可能弹出授权对话框），没保存 key 时 Butler 不碰钥匙串。
   */
  private boxAvailable: boolean | null = null;

  constructor(private readonly d: KeyStoreDeps) {}

  save(key: string): KeyState {
    const k = key.trim();
    if (!KEY_FORMAT.test(k)) {
      throw new SettingError(M().apiKeyFormatLong);
    }
    this.boxAvailable = this.d.box.available();
    if (!this.boxAvailable) throw new SettingError(M().noEncryption);
    let cipher: Uint8Array;
    try {
      cipher = this.d.box.encrypt(k);
    } catch {
      // 不转发底层错误：有的实现会把明文带进 message。
      throw new SettingError(M().encryptionFailed);
    }
    this.d.secrets.set(API_KEY_SECRET, cipher, this.d.now());
    this.cache = null;
    return this.state();
  }

  clear(): KeyState {
    this.d.secrets.delete(API_KEY_SECRET);
    this.cache = null;
    return this.state();
  }

  /** 有没有保存过 key。只查数据库，不碰系统钥匙串（没配置时 gateway 不会去访问钥匙串）。 */
  saved(): boolean {
    return this.d.secrets.get(API_KEY_SECRET) !== null;
  }

  /** 只给 gateway 用。没有保存、解不开、或解出来格式不对时为 null。 */
  get(): string | null {
    const key = this.read();
    if (key === null && this.saved()) this.logUnreadable();
    return key;
  }

  state(): KeyState {
    const saved = this.saved();
    // 没保存 key：不碰钥匙串。报告"没发现不可用"（true），真正的检查在 save() 里。
    if (!saved) return { keySaved: false, keyMasked: null, keyUnreadable: false, encryptionAvailable: this.boxAvailable ?? true };
    if (!this.cache) {
      const key = this.read();
      this.cache = { masked: key ? maskKey(key) : null, unreadable: key === null };
      if (key === null) this.logUnreadable();
    }
    // 上面的解密（这次或之前）已经访问过钥匙串，这里再查一次可用性不会多出一次授权。
    this.boxAvailable ??= this.d.box.available();
    return { keySaved: true, keyMasked: this.cache.masked, keyUnreadable: this.cache.unreadable, encryptionAvailable: this.boxAvailable };
  }

  private read(): string | null {
    const data = this.d.secrets.get(API_KEY_SECRET);
    if (!data) return null;
    try {
      const key = this.d.box.decrypt(data);
      return KEY_FORMAT.test(key) ? key : null;
    } catch {
      return null;
    }
  }

  // 固定文案：不记录错误对象，有的实现会把密文或明文片段带进 message。
  private logUnreadable(): void {
    this.d.log?.("saved API key cannot be decrypted; it needs to be entered again");
  }
}
