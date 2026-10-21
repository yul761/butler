import { describe, expect, it } from "vitest";
import { AuditRepo } from "../db/audit-repo";
import { SecretsRepo } from "../db/secrets-repo";
import { SettingsRepo } from "../db/settings-repo";
import { memDb } from "../test-utils";
import { KeyStore } from "./key-store";
import { AUDIT_PAGE_SIZE, auditPage, llmStatus } from "./status";
import { fakeSecretBox } from "./testing";

const NOW = new Date(2026, 9, 21, 9).getTime();

describe("llmStatus", () => {
  it("is configured only with a level, a URL, a model and, for a remote service, a readable key", () => {
    const db = memDb();
    const settings = new SettingsRepo(db);
    const audit = new AuditRepo(db);
    const box = fakeSecretBox();
    const secrets = new SecretsRepo(db);
    let keys = new KeyStore({ secrets, box, now: () => 1 });
    const status = () => llmStatus({ settings, keys, audit, now: () => NOW });

    expect(status()).toEqual({
      keySaved: false, keyMasked: null, keyUnreadable: false, encryptionAvailable: true,
      configured: false, priceKnown: false, monthCostUsd: 0, budgetUsd: 1,
    });
    settings.set("llmBaseUrl", "https://api.deepseek.com/v1");
    settings.set("llmModel", "deepseek-chat");
    expect(status()).toMatchObject({ configured: false, priceKnown: true });
    keys.save("sk-0123456789abcdef");
    expect(status()).toMatchObject({ configured: true, keyMasked: "••••cdef" });
    box.setBroken(true);
    // KeyStore 缓存了 state()：钥匙串在运行中坏掉要到下次启动才看得出来，这里模拟重启。
    keys = new KeyStore({ secrets, box, now: () => 1 });
    expect(status()).toMatchObject({ configured: false, keyUnreadable: true });
    settings.set("llmBaseUrl", "http://localhost:11434/v1");
    expect(status().configured).toBe(true);
    settings.set("llmLevel", "off");
    expect(status().configured).toBe(false);
    settings.set("llmPrices", "gpt-* 1 1");
    expect(status().priceKnown).toBe(false);
    const id = audit.insert({ ts: new Date(2026, 9, 2).getTime(), provider: "x", model: "m", level: "metadata", status: "pending", payloadSent: null });
    audit.finish(id, { status: "sent", costUsd: 0.25 });
    expect(status().monthCostUsd).toBe(0.25);
  });

  it("never contains the key itself", () => {
    const db = memDb();
    const keys = new KeyStore({ secrets: new SecretsRepo(db), box: fakeSecretBox(), now: () => 1 });
    keys.save("sk-secret-0123456789");
    const s = llmStatus({ settings: new SettingsRepo(db), keys, audit: new AuditRepo(db), now: () => NOW });
    expect(JSON.stringify(s)).not.toContain("sk-secret");
  });
});

describe("auditPage", () => {
  const row = (ts: number) => ({ ts, provider: "x", model: "m", level: "metadata" as const, status: "pending" as const, payloadSent: "{}" });

  it("pages newest first with a cursor and reports this month's cost and the budget", () => {
    const db = memDb();
    const settings = new SettingsRepo(db);
    const audit = new AuditRepo(db);
    const keys = new KeyStore({ secrets: new SecretsRepo(db), box: fakeSecretBox(), now: () => 1 });
    const ids = Array.from({ length: AUDIT_PAGE_SIZE + 3 }, (_, i) => audit.insert(row(NOW - i)));
    audit.finish(ids[0], { status: "sent", costUsd: 0.5 });
    settings.set("llmMonthlyBudgetUsd", "3");
    const d = { settings, audit, keys, now: () => NOW };

    const first = auditPage(d);
    expect(first.entries).toHaveLength(AUDIT_PAGE_SIZE);
    expect(first.entries[0].id).toBe(ids[ids.length - 1]);
    expect(first).toMatchObject({ hasMore: true, monthCostUsd: 0.5, budgetUsd: 3 });
    const second = auditPage(d, first.entries[first.entries.length - 1].id);
    expect(second.entries.map((e) => e.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(second.hasMore).toBe(false);
  });

  it("scrubs the saved key from every text field it returns", () => {
    const db = memDb();
    const audit = new AuditRepo(db);
    const keys = new KeyStore({ secrets: new SecretsRepo(db), box: fakeSecretBox(), now: () => 1 });
    const key = "sk-leaky-0123456789";
    keys.save(key);
    const id = audit.insert({ ...row(NOW), payloadSent: `{"k":"${key}"}` });
    audit.finish(id, { status: "failed", response: `echo ${key}`, error: `Authorization: Bearer ${key}` });
    const page = auditPage({ settings: new SettingsRepo(db), audit, keys, now: () => NOW });
    expect(JSON.stringify(page)).not.toContain("sk-leaky");
    expect(page.entries[0].payloadSent).toBe('{"k":"***"}');
  });
});
