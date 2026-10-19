import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HookEnvelope } from "../../shared/hook-envelope";
import { tempDir } from "../test-utils";
import { HookInbox } from "./inbox";

const envelope = (n: number) => JSON.stringify({ v: 1, receivedAt: n, ticket: null, butlerSession: null, payload: { n } });

describe("HookInbox.drain", () => {
  it("handles files in name order, deletes them, quarantines bad ones, skips .tmp", async () => {
    const root = tempDir();
    const dir = join(root, "inbox");
    const bad = join(dir, "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "0002-a.json"), envelope(2));
    writeFileSync(join(dir, "0001-a.json"), envelope(1));
    writeFileSync(join(dir, "0003-a.json"), "{broken");
    writeFileSync(join(dir, "0004-a.json"), envelope(4));
    writeFileSync(join(dir, "0005-a.json.tmp"), envelope(5));

    const seen: number[] = [];
    const inbox = new HookInbox({
      dir, badDir: bad,
      handle: (e: HookEnvelope) => {
        if (e.receivedAt === 4) throw new Error("handler failed");
        seen.push(e.receivedAt);
      },
    });
    expect(await inbox.drain()).toBe(2);
    expect(seen).toEqual([1, 2]);
    expect(readdirSync(dir).sort()).toEqual(["0005-a.json.tmp", "bad"]);
    expect(readdirSync(bad).sort()).toEqual(["0003-a.json", "0004-a.json"]);
  });

  it("creates the directory if missing", async () => {
    const dir = join(tempDir(), "inbox");
    const inbox = new HookInbox({ dir, badDir: join(dir, "bad"), handle: () => undefined });
    expect(await inbox.drain()).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });
});
