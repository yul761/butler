import { describe, expect, it } from "vitest";
import { RENAME_ATTEMPTS, renameWithRetry, renameWithRetrySync } from "./fs-retry";

const err = (code: string) => Object.assign(new Error(code), { code });

describe("rename with retry (plan 1 Task 6: Windows EPERM / EBUSY)", () => {
  it("retries a briefly locked file and then succeeds", async () => {
    let calls = 0;
    const waits: number[] = [];
    await renameWithRetry("a", "b", {
      rename: async () => {
        if (++calls < 3) throw err(calls === 1 ? "EPERM" : "EBUSY");
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(calls).toBe(3);
    expect(waits).toEqual([20, 40]);
  });

  it("gives up after a bounded number of attempts and rethrows the last error", async () => {
    let calls = 0;
    await expect(
      renameWithRetry("a", "b", {
        rename: async () => {
          calls++;
          throw err("EACCES");
        },
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("EACCES");
    expect(calls).toBe(RENAME_ATTEMPTS);
  });

  it("does not retry other errors", () => {
    let calls = 0;
    expect(() =>
      renameWithRetrySync("a", "b", {
        rename: () => {
          calls++;
          throw err("ENOENT");
        },
        sleep: () => undefined,
      }),
    ).toThrow("ENOENT");
    expect(calls).toBe(1);
  });

  it("works synchronously too", () => {
    let calls = 0;
    renameWithRetrySync("a", "b", {
      rename: () => {
        if (++calls < 2) throw err("EBUSY");
      },
      sleep: () => undefined,
    });
    expect(calls).toBe(2);
  });
});
