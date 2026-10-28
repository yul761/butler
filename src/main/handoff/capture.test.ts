import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HookEnvelope } from "../../shared/hook-envelope";
import { FeatureHandoffsRepo } from "../db/feature-handoffs-repo";
import { FeaturesRepo } from "../db/features-repo";
import { FollowupsRepo } from "../db/followups-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { insertTicket, memDb, tempDir } from "../test-utils";
import { captureCommandHandoff, stopFromEnvelope } from "./capture";
import { ingestFeatureHandoff, type FeatureIngestInput } from "./feature-ingest";
import { ingestHandoff, type IngestInput } from "./ingest";
import { emptyHandoff } from "./schema";

const FENCE = "```";

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  for (const key of ["PROJ-1", "PROJ-2"]) {
    insertTicket(tickets, { key, title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  }
  const sessions = new SessionsRepo(db);
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  let n = 0;
  const ingest = (input: IngestInput) => ingestHandoff({ db, tickets, handoffs, followups, now: () => 100, newFollowupId: () => `f${++n}` }, input);
  // feature 1..3；总控测试用 3（id 不是 1，免得和别的计数巧合对上）。
  const features = new FeaturesRepo(db);
  for (const name of ["a", "b", "c"]) features.insert({ name, workspaceDir: `/w/${name}`, createdAt: 1 });
  const featureHandoffs = new FeatureHandoffsRepo(db);
  const featureInputs: FeatureIngestInput[] = [];
  const ingestFeature = (input: FeatureIngestInput) => {
    featureInputs.push(input);
    return ingestFeatureHandoff({ features, tickets, featureHandoffs, now: () => 100 }, input);
  };
  const afterCalls: [number, number | null, string][] = [];
  const afterFeatureCommand = (featureId: number, handoffId: number | null, sessionId: string) => void afterCalls.push([featureId, handoffId, sessionId]);
  return { deps: { sessions, tickets, ingest, ingestFeature, afterFeatureCommand }, sessions, handoffs, featureHandoffs, featureInputs, afterCalls };
}

/** 一个只有“/handoff + 回答”的 transcript；payload 是字符串时原样放进代码块。 */
function transcript(payload: unknown, uuid = "a1"): string {
  const file = join(tempDir(), "t.jsonl");
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const entries = [
    { type: "user", message: { role: "user", content: "/handoff" } },
    { type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text: `${FENCE}butler-handoff\n${body}\n${FENCE}` }] } },
  ];
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

describe("stopFromEnvelope", () => {
  const env = (payload: unknown, butlerSession: string | null = null): HookEnvelope => ({ v: 1, receivedAt: 1, ticket: null, butlerSession, payload });

  it("extracts session and transcript from Stop only, never from headless runs", () => {
    const stop = { hook_event_name: "Stop", session_id: "s1", transcript_path: "/t.jsonl" };
    expect(stopFromEnvelope(env(stop))).toEqual({ sessionId: "s1", transcriptPath: "/t.jsonl" });
    expect(stopFromEnvelope(env(stop, "headless:r1"))).toBeNull();
    expect(stopFromEnvelope(env({ ...stop, hook_event_name: "SessionEnd" }))).toBeNull();
    expect(stopFromEnvelope(env({ hook_event_name: "Stop", session_id: "s1" }))).toBeNull();
    expect(stopFromEnvelope(env(null))).toBeNull();
  });
});

describe("captureCommandHandoff", () => {
  it("stores a /handoff block under the session's ticket with trigger command", async () => {
    const { deps, sessions, handoffs } = setup();
    sessions.insertIfAbsent({ id: "s1", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1 });
    const file = transcript({ ...emptyHandoff("WHATEVER-1"), done_today: ["写完了"] });
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: file })).toMatchObject({ stored: true, degraded: false });
    expect(handoffs.latest("PROJ-1")).toMatchObject({ trigger: "command", sessionId: "s1", sourceRef: "a1", payload: { ticket: "PROJ-1", done_today: ["写完了"] } });
  });

  it("does not store the same output twice when Stop is handled again", async () => {
    const { deps, sessions, handoffs } = setup();
    sessions.insertIfAbsent({ id: "s1", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1 });
    const file = transcript(emptyHandoff("PROJ-1"));
    await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: file });
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: file })).toEqual({ stored: false, reason: "duplicate" });
    expect(handoffs.listByTicket("PROJ-1")).toHaveLength(1);
  });

  it("falls back to the ticket named in the block for an unclaimed session, else gives up", async () => {
    const { deps, handoffs } = setup();
    expect(await captureCommandHandoff(deps, { sessionId: "loose", transcriptPath: transcript(emptyHandoff("proj-2")) })).toMatchObject({ stored: true });
    expect(handoffs.latest("PROJ-2")?.trigger).toBe("command");
    expect(await captureCommandHandoff(deps, { sessionId: "loose", transcriptPath: transcript(emptyHandoff("NOPE-9"), "a2") })).toEqual({
      stored: false, reason: "no_ticket",
    });
  });

  it("keeps an invalid block as a degraded handoff with its raw text", async () => {
    const { deps, sessions, handoffs } = setup();
    sessions.insertIfAbsent({ id: "s1", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1 });
    const raw = '{"ticket":"PROJ-1","status":"shipping"}';
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: transcript(raw) })).toMatchObject({ stored: true, degraded: true });
    expect(handoffs.latest("PROJ-1")).toMatchObject({ degraded: true, rawText: raw });
  });

  it("returns null when there is no block or no file", async () => {
    const { deps } = setup();
    const file = join(tempDir(), "plain.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "assistant", uuid: "x", message: { content: [{ type: "text", text: "普通回答" }] } })}\n`);
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: file })).toBeNull();
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: join(tempDir(), "missing.jsonl") })).toBeNull();
  });

  it("ignores a turn where the assistant merely quotes a fence without /handoff", async () => {
    const { deps, sessions, handoffs } = setup();
    sessions.insertIfAbsent({ id: "s1", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1 });
    const file = join(tempDir(), "quote.jsonl");
    const entries = [
      { type: "user", message: { role: "user", content: "给我看看 handoff 的格式" } },
      { type: "assistant", uuid: "q1", message: { role: "assistant", content: [{ type: "text", text: `${FENCE}butler-handoff\n${JSON.stringify(emptyHandoff("PROJ-1"))}\n${FENCE}` }] } },
    ];
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: file })).toBeNull();
    expect(handoffs.listByTicket("PROJ-1")).toHaveLength(0);
  });

  it("ingests the V4-shaped /handoff turn (command message + isMeta expansion)", async () => {
    const { deps, sessions, handoffs } = setup();
    sessions.insertIfAbsent({ id: "s1", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1 });
    const file = join(tempDir(), "v4.jsonl");
    const entries = [
      { type: "user", message: { role: "user", content: "<command-message>handoff</command-message>\n<command-name>/handoff</command-name>" } },
      { type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: `示例：\n${FENCE}butler-handoff\n{}\n${FENCE}` }] } },
      { type: "assistant", uuid: "v1", message: { role: "assistant", content: [{ type: "text", text: `${FENCE}butler-handoff\n${JSON.stringify(emptyHandoff("PROJ-1"))}\n${FENCE}` }] } },
    ];
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: file })).toMatchObject({ stored: true });
    expect(handoffs.latest("PROJ-1")).toMatchObject({ trigger: "command", sourceRef: "v1" });
  });
});

describe("captureCommandHandoff when the transcript lags behind the Stop hook", () => {
  const userHandoff = { type: "user", message: { role: "user", content: "/handoff" } };
  const narration = { type: "assistant", uuid: "n1", message: { role: "assistant", content: [{ type: "text", text: "我先看一下 PR 状态。" }] } };
  const write = (file: string, entries: object[]) => writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

  it("reads again until the answer shows up, then stores it", async () => {
    const { deps, sessions, handoffs } = setup();
    sessions.insertIfAbsent({ id: "s1", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1 });
    const file = join(tempDir(), "lag.jsonl");
    write(file, [userHandoff, narration]);
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
      // claude 写完最后一条回答。
      if (waits.length === 2) {
        write(file, [userHandoff, narration, {
          type: "assistant", uuid: "a9", message: { role: "assistant", content: [{ type: "text", text: `${FENCE}butler-handoff\n${JSON.stringify(emptyHandoff("PROJ-1"))}\n${FENCE}` }] },
        }]);
      }
    };
    expect(await captureCommandHandoff({ ...deps, sleep }, { sessionId: "s1", transcriptPath: file })).toMatchObject({ stored: true });
    expect(waits).toEqual([500, 1500]);
    expect(handoffs.latest("PROJ-1")).toMatchObject({ trigger: "command" });
  });

  it("gives up after the last retry and says why", async () => {
    const { deps } = setup();
    const file = join(tempDir(), "never.jsonl");
    write(file, [userHandoff, narration]);
    const waits: number[] = [];
    expect(await captureCommandHandoff({ ...deps, sleep: async (ms) => void waits.push(ms) }, { sessionId: "s1", transcriptPath: file })).toEqual({ stored: false, reason: "no_block" });
    expect(waits).toEqual([500, 1500, 5000]);
  });

  it("does not wait at all for a turn that is not /handoff", async () => {
    const { deps } = setup();
    const file = join(tempDir(), "plain2.jsonl");
    write(file, [{ type: "user", message: { role: "user", content: "随便问问" } }, narration]);
    const waits: number[] = [];
    expect(await captureCommandHandoff({ ...deps, sleep: async (ms) => void waits.push(ms) }, { sessionId: "s1", transcriptPath: file })).toBeNull();
    expect(waits).toEqual([]);
  });

  it("accepts the handoff in a plain ```json block when claude did not use the butler-handoff fence", async () => {
    const { deps, sessions, handoffs } = setup();
    sessions.insertIfAbsent({ id: "s1", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1 });
    const file = join(tempDir(), "json.jsonl");
    write(file, [userHandoff, {
      type: "assistant", uuid: "j1",
      message: { role: "assistant", content: [{ type: "text", text: `示例配置：\n${FENCE}json\n{"a":1}\n${FENCE}\n结果：\n${FENCE}json\n${JSON.stringify({ ...emptyHandoff("PROJ-1"), next_steps: ["合并 PR"] })}\n${FENCE}` }] },
    }]);
    expect(await captureCommandHandoff({ ...deps, sleep: async () => undefined }, { sessionId: "s1", transcriptPath: file })).toMatchObject({ stored: true, degraded: false });
    expect(handoffs.latest("PROJ-1")?.payload?.next_steps).toEqual(["合并 PR"]);
  });
});

describe("captureCommandHandoff in a feature coordinator", () => {
  const userHandoff = { type: "user", message: { role: "user", content: "/handoff" } };
  const write = (entries: object[]) => {
    const file = join(tempDir(), "c.jsonl");
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return file;
  };
  const answer = (uuid: string, text: string) => ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] } });
  const summary = { summary: "前端等 review，后端还差错误码。", blockers: [], next_steps: [{ ticket: "proj-1", text: "补错误码" }], decisions: [], open_questions: [] };
  const featureBlock = (v: unknown) => `${FENCE}butler-feature-handoff\n${typeof v === "string" ? v : JSON.stringify(v)}\n${FENCE}`;
  const coordinator = (sessions: SessionsRepo, id = "c1") =>
    sessions.insertIfAbsent({ id, ticketKey: null, cwd: "/w/c", origin: "butler", createdAt: 1, coordinator: true, featureId: 3 });

  it("stores the feature block as a command summary and starts the child handoffs once", async () => {
    const { deps, sessions, handoffs, featureHandoffs, featureInputs, afterCalls } = setup();
    coordinator(sessions);
    const file = write([userHandoff, answer("f1", `好的。\n${featureBlock(summary)}`)]);
    const r = await captureCommandHandoff({ ...deps, sleep: async () => undefined }, { sessionId: "c1", transcriptPath: file });
    expect(r).toMatchObject({ featureId: 3, stored: true, degraded: false });
    expect(featureInputs).toHaveLength(1);
    expect(featureInputs[0]).toMatchObject({ featureId: 3, trigger: "command", sessionId: "c1", sourceRef: "f1", rawText: JSON.stringify(summary) });
    const stored = featureHandoffs.latest(3);
    expect(stored).toMatchObject({ trigger: "command", sessionId: "c1", payload: { summary: summary.summary } });
    expect(afterCalls).toEqual([[3, stored?.id, "c1"]]);
    expect(handoffs.listByTicket("PROJ-1")).toHaveLength(0);
  });

  it("does not start the children again when the same Stop is handled twice", async () => {
    const { deps, sessions, featureHandoffs, afterCalls } = setup();
    coordinator(sessions);
    const file = write([userHandoff, answer("f1", featureBlock(summary))]);
    await captureCommandHandoff(deps, { sessionId: "c1", transcriptPath: file });
    expect(await captureCommandHandoff(deps, { sessionId: "c1", transcriptPath: file })).toEqual({ featureId: 3, stored: false, reason: "duplicate" });
    expect(featureHandoffs.listByFeature(3)).toHaveLength(1);
    expect(afterCalls).toHaveLength(1);
  });

  it("keeps an invalid feature block as a degraded summary", async () => {
    const { deps, sessions, featureHandoffs, afterCalls } = setup();
    coordinator(sessions);
    const raw = '{"summary":""}';
    const file = write([userHandoff, answer("f2", featureBlock(raw))]);
    expect(await captureCommandHandoff(deps, { sessionId: "c1", transcriptPath: file })).toMatchObject({ featureId: 3, stored: true, degraded: true });
    expect(featureHandoffs.latest(3)).toMatchObject({ degraded: true, rawText: raw, payload: null });
    expect(afterCalls).toEqual([[3, featureHandoffs.latest(3)?.id, "c1"]]);
  });

  it("stores nothing for a ticket block naming an existing ticket, but still starts the children", async () => {
    const { deps, sessions, handoffs, featureHandoffs, featureInputs, afterCalls } = setup();
    coordinator(sessions);
    const ingested: IngestInput[] = [];
    const ingest = (i: IngestInput) => {
      ingested.push(i);
      return deps.ingest(i);
    };
    const file = write([userHandoff, answer("t1", `${FENCE}butler-handoff\n${JSON.stringify(emptyHandoff("PROJ-1"))}\n${FENCE}`)]);
    const r = await captureCommandHandoff({ ...deps, ingest, sleep: async () => undefined }, { sessionId: "c1", transcriptPath: file });
    expect(r).toEqual({ featureId: 3, stored: false, reason: "wrong_block" });
    expect(ingested).toHaveLength(0);
    expect(featureInputs).toHaveLength(0);
    expect(handoffs.listByTicket("PROJ-1")).toHaveLength(0);
    expect(featureHandoffs.listByFeature(3)).toHaveLength(0);
    expect(afterCalls).toEqual([[3, null, "c1"]]);
  });

  it("accepts a feature summary in a plain ```json block", async () => {
    const { deps, sessions, featureHandoffs, afterCalls } = setup();
    coordinator(sessions);
    const file = write([userHandoff, answer("j1", `示例：\n${FENCE}json\n{"a":1}\n${FENCE}\n结果：\n${FENCE}json\n${JSON.stringify(summary)}\n${FENCE}`)]);
    const r = await captureCommandHandoff({ ...deps, sleep: async () => undefined }, { sessionId: "c1", transcriptPath: file });
    expect(r).toMatchObject({ featureId: 3, stored: true, degraded: false });
    expect(featureHandoffs.latest(3)).toMatchObject({ trigger: "command", sessionId: "c1", sourceRef: "j1", payload: { summary: summary.summary } });
    expect(afterCalls).toEqual([[3, featureHandoffs.latest(3)?.id, "c1"]]);
  });

  it("does not take a ticket handoff in a plain ```json block as the feature summary", async () => {
    const { deps, sessions, handoffs, featureInputs, afterCalls } = setup();
    coordinator(sessions);
    const file = write([userHandoff, answer("j2", `${FENCE}json\n${JSON.stringify(emptyHandoff("PROJ-1"))}\n${FENCE}`)]);
    const r = await captureCommandHandoff({ ...deps, sleep: async () => undefined }, { sessionId: "c1", transcriptPath: file });
    expect(r).toEqual({ featureId: 3, stored: false, reason: "wrong_block" });
    expect(featureInputs).toHaveLength(0);
    expect(handoffs.listByTicket("PROJ-1")).toHaveLength(0);
    expect(afterCalls).toEqual([[3, null, "c1"]]);
  });

  it("gives up after the retries with no_block and still starts the children", async () => {
    const { deps, sessions, featureInputs, afterCalls } = setup();
    coordinator(sessions);
    const file = write([userHandoff, answer("n1", "我先看一下各 ticket。")]);
    const waits: number[] = [];
    const r = await captureCommandHandoff({ ...deps, sleep: async (ms) => void waits.push(ms) }, { sessionId: "c1", transcriptPath: file });
    expect(r).toEqual({ featureId: 3, stored: false, reason: "no_block" });
    expect(waits).toEqual([500, 1500, 5000]);
    expect(featureInputs).toHaveLength(0);
    expect(afterCalls).toEqual([[3, null, "c1"]]);
  });

  it("waits for a late feature block like the ticket path does", async () => {
    const { deps, sessions, featureHandoffs } = setup();
    coordinator(sessions);
    const file = write([userHandoff, answer("n1", "我先看一下各 ticket。")]);
    const sleep = async () => {
      writeFileSync(file, [userHandoff, answer("n1", "我先看一下各 ticket。"), answer("f9", featureBlock(summary))].map((e) => JSON.stringify(e)).join("\n") + "\n");
    };
    expect(await captureCommandHandoff({ ...deps, sleep }, { sessionId: "c1", transcriptPath: file })).toMatchObject({ featureId: 3, stored: true });
    expect(featureHandoffs.latest(3)?.sourceRef).toBe("f9");
  });

  it("treats the new head after /clear as the same coordinator", async () => {
    const { deps, sessions, featureHandoffs, featureInputs, afterCalls } = setup();
    coordinator(sessions, "c0");
    sessions.insertIfAbsent({ id: "c1", ticketKey: null, cwd: "/w/c", origin: "butler", createdAt: 2 });
    sessions.setReplacedBy("c0", "c1");
    expect(sessions.get("c1")?.featureId).toBe(3);
    const file = write([userHandoff, answer("f1", featureBlock(summary))]);
    expect(await captureCommandHandoff(deps, { sessionId: "c1", transcriptPath: file })).toMatchObject({ featureId: 3, stored: true });
    expect(featureInputs[0]).toMatchObject({ featureId: 3, trigger: "command", sessionId: "c1" });
    expect(featureHandoffs.latest(3)?.sessionId).toBe("c1");
    expect(afterCalls).toEqual([[3, featureHandoffs.latest(3)?.id, "c1"]]);
  });

  it("falls back to a hash of the block as sourceRef when the entry has no uuid", async () => {
    const { deps, sessions, featureHandoffs } = setup();
    coordinator(sessions);
    const entry = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: featureBlock(summary) }] } };
    const file = write([userHandoff, entry]);
    await captureCommandHandoff(deps, { sessionId: "c1", transcriptPath: file });
    expect(featureHandoffs.latest(3)?.sourceRef).toMatch(/^c1:[0-9a-f]{40}$/);
  });

  it("leaves a ticket session alone even if it outputs a feature block", async () => {
    const { deps, sessions, featureInputs, afterCalls } = setup();
    sessions.insertIfAbsent({ id: "s1", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1 });
    const file = write([userHandoff, answer("f1", featureBlock(summary))]);
    expect(await captureCommandHandoff({ ...deps, sleep: async () => undefined }, { sessionId: "s1", transcriptPath: file })).toEqual({ stored: false, reason: "no_block" });
    expect(featureInputs).toHaveLength(0);
    expect(afterCalls).toHaveLength(0);
  });
});
