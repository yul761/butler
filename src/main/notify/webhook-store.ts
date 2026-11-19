import type { WebhookState } from "../../shared/interrupts";
import type { SecretsRepo } from "../db/secrets-repo";
import type { SecretBox } from "../gateway/key-store";
import { parseWebhookUrl } from "../gateway/webhook";
import { SettingError } from "../settings/settings-values";
import { M } from "../strings";

export const WEBHOOK_SECRET = "notify_webhook_url";

export interface WebhookStoreDeps {
  secrets: SecretsRepo;
  box: SecretBox;
  now(): number;
  log?(msg: string): void;
}

/**
 * 通知的 webhook 地址（ws-j 设计 7）：和 API key 一样只以密文落盘。完整地址只给 notifier（get），界面只看得到 host。
 * 没保存时不碰系统钥匙串。导出（config-io）不带它。
 */
export class WebhookStore {
  private cache: { host: string | null; unreadable: boolean } | null = null;
  private boxAvailable: boolean | null = null;

  constructor(private readonly d: WebhookStoreDeps) {}

  save(url: string): WebhookState {
    const u = parseWebhookUrl(url);
    if (!u) throw new SettingError(M().interrupts.webhookUrl);
    this.boxAvailable = this.d.box.available();
    if (!this.boxAvailable) throw new SettingError(M().noEncryption);
    let cipher: Uint8Array;
    try {
      cipher = this.d.box.encrypt(u.toString());
    } catch {
      throw new SettingError(M().encryptionFailed);
    }
    this.d.secrets.set(WEBHOOK_SECRET, cipher, this.d.now());
    this.cache = null;
    return this.state();
  }

  clear(): WebhookState {
    this.d.secrets.delete(WEBHOOK_SECRET);
    this.cache = null;
    return this.state();
  }

  saved(): boolean {
    return this.d.secrets.get(WEBHOOK_SECRET) !== null;
  }

  /** 只给 notifier 用。没有保存或解不开为 null。 */
  get(): string | null {
    const url = this.read();
    if (url === null && this.saved()) this.d.log?.("saved webhook address cannot be decrypted; it needs to be entered again");
    return url;
  }

  state(): WebhookState {
    if (!this.saved()) return { saved: false, host: null, unreadable: false, encryptionAvailable: this.boxAvailable ?? true };
    if (!this.cache) {
      const url = this.read();
      this.cache = { host: url ? new URL(url).host : null, unreadable: url === null };
    }
    this.boxAvailable ??= this.d.box.available();
    return { saved: true, host: this.cache.host, unreadable: this.cache.unreadable, encryptionAvailable: this.boxAvailable };
  }

  private read(): string | null {
    const data = this.d.secrets.get(WEBHOOK_SECRET);
    if (!data) return null;
    try {
      const url = this.d.box.decrypt(data);
      return parseWebhookUrl(url) ? url : null;
    } catch {
      return null;
    }
  }
}
