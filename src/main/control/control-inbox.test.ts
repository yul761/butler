import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ControlRequest } from "../../shared/control";
import { tempDir } from "../test-utils";
import { ControlInbox } from "./control-inbox";

function setup() {
  const dir = tempDir("butler-inbox-");
  const requestsDir = join(dir, "requests");
  const resultsDir = join(dir, "results");
  mkdirSync(requestsDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });
  const seen: ControlRequest[] = [];
  const inbox = new ControlInbox({
    requestsDir, resultsDir,
    handle: async (req) => {
      seen.push(req);
      if (req.op === "list_sessions") throw new Error("boom");
      return { v: 1, ok: true, value: req.op };
    },
  });
  const put = (id: string, body: unknown) => writeFileSync(join(requestsDir, `${id}.json`), typeof body === "string" ? body : JSON.stringify(body));
  const result = (id: string) => JSON.parse(readFileSync(join(resultsDir, `${id}.json`), "utf8")) as unknown;
  return { inbox, put, result, seen, requestsDir, resultsDir };
}

const id = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;

describe("ControlInbox", () => {
  it("answers each request once under the same id and removes the request", async () => {
    const { inbox, put, result, seen, requestsDir } = setup();
    put(id(1), { v: 1, ticketKey: "P-1", op: "list_repos" });
    put(id(2), { v: 1, ticketKey: "P-1", op: "list_sessions" });
    put(id(3), "not json");
    put(id(4), { v: 1, ticketKey: "P-1", op: "type_keys" });
    expect(await inbox.drain()).toBe(4);
    expect(result(id(1))).toEqual({ v: 1, ok: true, value: "list_repos" });
    expect(result(id(2))).toEqual({ v: 1, ok: false, error: "boom" });
    expect(result(id(3))).toMatchObject({ ok: false });
    expect(result(id(4))).toEqual({ v: 1, ok: false, error: "请求格式不对" });
    expect(readdirSync(requestsDir)).toEqual([]);
    expect(await inbox.drain()).toBe(0);
    expect(seen.map((r) => r.op)).toEqual(["list_repos", "list_sessions"]);
  });

  it("drops files whose name is not a request id, and ignores unfinished temp files", async () => {
    const { inbox, put, requestsDir, resultsDir } = setup();
    put("short", { v: 1, ticketKey: "P-1", op: "list_repos" });
    writeFileSync(join(requestsDir, `${id(5)}.tmp`), "{");
    await inbox.drain();
    expect(readdirSync(resultsDir)).toEqual([]);
    expect(readdirSync(requestsDir)).toEqual([`${id(5)}.tmp`]);
  });

  it("does not run requests that are too old for anyone to be waiting on", async () => {
    const { inbox, put, requestsDir, resultsDir, seen } = setup();
    put(id(8), { v: 1, ticketKey: "P-1", op: "start_session", repo: "api", task: "x" });
    utimesSync(join(requestsDir, `${id(8)}.json`), new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 10 * 60_000));
    await inbox.drain();
    expect(seen).toEqual([]);
    expect(readdirSync(requestsDir)).toEqual([]);
    expect(readdirSync(resultsDir)).toEqual([]);
  });

  it("clears results nobody collected when it starts", async () => {
    const { resultsDir, requestsDir } = setup();
    const old = join(resultsDir, `${id(6)}.json`);
    const fresh = join(resultsDir, `${id(7)}.json`);
    const tmp = join(requestsDir, `${id(9)}.tmp`);
    writeFileSync(old, "{}");
    writeFileSync(fresh, "{}");
    writeFileSync(tmp, "{");
    utimesSync(old, new Date(0), new Date(0));
    utimesSync(tmp, new Date(0), new Date(0));
    const inbox = new ControlInbox({ requestsDir, resultsDir, handle: async () => ({ v: 1, ok: true, value: null }), intervalMs: 60_000 });
    inbox.start();
    await new Promise((r) => setTimeout(r, 50));
    inbox.stop();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(tmp)).toBe(false);
  });
});
