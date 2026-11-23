import { describe, expect, it } from "vitest";
import { SecretsRepo } from "../db/secrets-repo";
import { memDb } from "../test-utils";
import { fakeSecretBox } from "../testing/fake-secret-box";
import { WebhookStore } from "./webhook-store";

// BTL-260：改名后系统钥匙串里旧 app 名下的条目可能读不到（比如 macOS 的钥匙串项按 app 名字存）。
// 这时不能崩，界面显示“需要重新填写”，重新保存之后照常用。
describe("WebhookStore when the saved address cannot be decrypted", () => {
  it("reports it as unreadable instead of throwing, and works again once re-entered", () => {
    const box = fakeSecretBox();
    const logs: string[] = [];
    const secrets = new SecretsRepo(memDb());
    const store = new WebhookStore({ secrets, box, now: () => 1, log: (m) => logs.push(m) });
    store.save("https://hooks.example/abc");
    box.setBroken(true);
    const fresh = new WebhookStore({ secrets, box, now: () => 2, log: (m) => logs.push(m) });
    expect(fresh.state()).toEqual({ saved: true, host: null, unreadable: true, encryptionAvailable: true });
    expect(fresh.get()).toBeNull();
    expect(logs.join("\n")).toContain("entered again");
    box.setBroken(false);
    expect(fresh.save("https://hooks.example/new")).toEqual({ saved: true, host: "hooks.example", unreadable: false, encryptionAvailable: true });
    expect(fresh.get()).toBe("https://hooks.example/new");
  });
});
