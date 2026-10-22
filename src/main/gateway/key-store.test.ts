import { describe, expect, it } from "vitest";
import { SecretsRepo } from "../db/secrets-repo";
import { SettingError } from "../settings/settings-values";
import { memDb } from "../test-utils";
import { API_KEY_SECRET, KeyStore, maskKey } from "./key-store";
import { fakeSecretBox } from "./testing";

const KEY = "sk-live-abcdefghijklmnop1234";

function setup() {
  const secrets = new SecretsRepo(memDb());
  const box = fakeSecretBox();
  const logs: string[] = [];
  const keys = new KeyStore({ secrets, box, now: () => 1, log: (m) => logs.push(m) });
  return { secrets, box, keys, logs };
}

describe("KeyStore", () => {
  it("stores only ciphertext and exposes a masked form", () => {
    const { secrets, keys } = setup();
    expect(keys.saved()).toBe(false);
    expect(keys.state()).toEqual({ keySaved: false, keyMasked: null, keyUnreadable: false, encryptionAvailable: true });
    expect(keys.save(`  ${KEY}\n`)).toEqual({ keySaved: true, keyMasked: "••••1234", keyUnreadable: false, encryptionAvailable: true });
    expect(Buffer.from(secrets.get(API_KEY_SECRET)!).toString("latin1")).not.toContain("sk-live");
    expect(keys.get()).toBe(KEY);
    expect(keys.saved()).toBe(true);
    expect(JSON.stringify(keys.state())).not.toContain(KEY.slice(0, -4));
  });

  it("refuses malformed keys and refuses to save when system encryption is unavailable", () => {
    const { keys, box, secrets } = setup();
    for (const bad of ["short", "sk live with spaces 1234", `sk-${"x".repeat(600)}`, "sk-abc\ndefghij"]) {
      expect(() => keys.save(bad), bad).toThrow(SettingError);
    }
    box.setAvailable(false);
    expect(() => keys.save(KEY)).toThrow(SettingError);
    expect(secrets.get(API_KEY_SECRET)).toBeNull();
    expect(keys.state().encryptionAvailable).toBe(false);
  });

  it("reports a key that can no longer be decrypted, without logging it, and can clear it", () => {
    const { keys, box, logs, secrets } = setup();
    keys.save(KEY);
    box.setBroken(true);
    expect(keys.get()).toBeNull();
    // state() is cached from save(); a fresh store (app restart) sees the unreadable key.
    const keys2 = new KeyStore({ secrets, box, now: () => 1, log: (m) => logs.push(m) });
    expect(keys2.state()).toEqual({ keySaved: true, keyMasked: null, keyUnreadable: true, encryptionAvailable: true });
    expect(logs.join("\n")).not.toContain("sk-live");
    expect(keys.clear()).toMatchObject({ keySaved: false, keyUnreadable: false });
  });

  it("masks short keys entirely", () => {
    expect(maskKey("abcdefgh")).toBe("••••");
    expect(maskKey("abcdefghijkl")).toBe("••••ijkl");
  });

  it("never leaks the key text through errors, logs, state or stored bytes, even if the box echoes it", () => {
    const secrets = new SecretsRepo(memDb());
    const inner = fakeSecretBox();
    let echo = false;
    // A hostile box whose failures carry the plaintext, to prove KeyStore does not forward them.
    const box = {
      available: () => true,
      encrypt: (p: string) => {
        if (echo) throw new Error(`cannot encrypt ${p}`);
        return inner.encrypt(p);
      },
      decrypt: (d: Uint8Array) => {
        if (echo) throw new Error(`cannot decrypt ${KEY}`);
        return inner.decrypt(d);
      },
    };
    const logs: unknown[][] = [];
    const keys = new KeyStore({ secrets, box, now: () => 1, log: (...a) => logs.push(a) });
    keys.save(KEY);
    echo = true;
    const thrown: string[] = [];
    try {
      keys.save(`${KEY}-other`);
    } catch (e) {
      thrown.push(String((e as Error).message));
    }
    expect(thrown.length).toBe(1);
    expect(keys.get()).toBeNull();
    const state = JSON.stringify(keys.state());
    const stored = Buffer.from(secrets.get(API_KEY_SECRET)!).toString("latin1");
    for (const where of [thrown.join("\n"), JSON.stringify(logs), state, stored]) {
      expect(where).not.toContain(KEY);
      expect(where).not.toContain("sk-live");
    }
  });

  it("accepts printable ASCII only and does not echo a rejected key", () => {
    const { keys } = setup();
    for (const bad of ["sk-abcd\u200befgh", "sk-abcd\u0085efgh", "sk-аbcdefgh", "sk-••••efgh"]) {
      let msg = "";
      try {
        keys.save(bad);
      } catch (e) {
        expect(e).toBeInstanceOf(SettingError);
        msg = (e as Error).message;
      }
      expect(msg, bad).not.toBe("");
      expect(msg).not.toContain("sk-");
    }
  });

  it("state() decrypts and logs once, not on every call; save and clear invalidate", () => {
    const secrets = new SecretsRepo(memDb());
    const inner = fakeSecretBox();
    let decrypts = 0;
    const box = { available: () => true, encrypt: inner.encrypt, decrypt: (d: Uint8Array) => (decrypts++, inner.decrypt(d)) };
    const logs: string[] = [];
    const keys = new KeyStore({ secrets, box, now: () => 1, log: (m) => logs.push(m) });
    keys.save(KEY);
    decrypts = 0;
    keys.state();
    keys.state();
    keys.state();
    expect(decrypts).toBe(0);
    keys.clear();
    expect(keys.state().keySaved).toBe(false);
    keys.save(KEY);
    expect(keys.state().keyMasked).toBe("••••1234");
    // unreadable path: cache filled once
    inner.setBroken(true);
    const k2 = new KeyStore({ secrets, box, now: () => 1, log: (m) => logs.push(m) });
    decrypts = 0;
    logs.length = 0;
    k2.state();
    k2.state();
    k2.state();
    expect(decrypts).toBe(1);
    expect(logs).toHaveLength(1);
  });

  it("never touches the keychain while no key is saved: state(), clear() and get()", () => {
    const secrets = new SecretsRepo(memDb());
    const inner = fakeSecretBox();
    const calls: string[] = [];
    const box = {
      available: () => (calls.push("available"), inner.available()),
      encrypt: (p: string) => (calls.push("encrypt"), inner.encrypt(p)),
      decrypt: (d: Uint8Array) => (calls.push("decrypt"), inner.decrypt(d)),
    };
    const keys = new KeyStore({ secrets, box, now: () => 1 });
    expect(keys.state()).toEqual({ keySaved: false, keyMasked: null, keyUnreadable: false, encryptionAvailable: true });
    keys.state();
    expect(keys.get()).toBeNull();
    expect(keys.saved()).toBe(false);
    expect(keys.clear()).toMatchObject({ keySaved: false, encryptionAvailable: true });
    expect(calls).toEqual([]);
    // Saving checks for real, once (save() then reads the key back for its masked form); later state() calls reuse both.
    keys.save(KEY);
    expect(calls).toEqual(["available", "encrypt", "decrypt"]);
    calls.length = 0;
    keys.state();
    keys.state();
    expect(calls).toEqual([]);
    // After clear(), the last known answer is reported without asking the box again.
    keys.clear();
    expect(keys.state().encryptionAvailable).toBe(true);
    expect(calls).toEqual([]);
  });

  it("with a key saved, a fresh store checks availability only after the decrypt, and once", () => {
    const secrets = new SecretsRepo(memDb());
    const inner = fakeSecretBox();
    new KeyStore({ secrets, box: inner, now: () => 1 }).save(KEY);
    const calls: string[] = [];
    const box = {
      available: () => (calls.push("available"), inner.available()),
      encrypt: (p: string) => (calls.push("encrypt"), inner.encrypt(p)),
      decrypt: (d: Uint8Array) => (calls.push("decrypt"), inner.decrypt(d)),
    };
    const keys = new KeyStore({ secrets, box, now: () => 1 });
    expect(keys.state()).toEqual({ keySaved: true, keyMasked: "••••1234", keyUnreadable: false, encryptionAvailable: true });
    keys.state();
    expect(calls).toEqual(["decrypt", "available"]);
  });

  it("get() returns null when the decrypted value fails the format check", () => {
    const { secrets, box, keys, logs } = setup();
    secrets.set(API_KEY_SECRET, box.encrypt("has space inside"), 1);
    expect(keys.get()).toBeNull();
    expect(logs).toHaveLength(1);
  });
});
