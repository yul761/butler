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
    const { keys, box, logs } = setup();
    keys.save(KEY);
    box.setBroken(true);
    expect(keys.get()).toBeNull();
    expect(keys.state()).toEqual({ keySaved: true, keyMasked: null, keyUnreadable: true, encryptionAvailable: true });
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
});
