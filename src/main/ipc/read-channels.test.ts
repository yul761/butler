import { describe, expect, it } from "vitest";
import { isReadChannel } from "./read-channels";
import { IPC } from "../../shared/ipc";

describe("isReadChannel", () => {
  it("knows the refresh burst's channels are reads", () => {
    for (const c of [IPC.ticketsList, IPC.featuresList, IPC.nowView, IPC.turnBoard, IPC.sessionsLimits, IPC.healthGet, IPC.loopPolicyGet, IPC.memUsageHistory]) {
      expect(isReadChannel(c), c).toBe(true);
    }
  });

  it("treats writes as writes", () => {
    for (const c of [IPC.ticketsCreate, IPC.ticketsArchive, IPC.ticketsSetStatus, IPC.settingsSet, IPC.lessonsRun, IPC.lessonsAct, IPC.turnSendToAgent, IPC.ptyKill, IPC.intakePoll, IPC.convSend]) {
      expect(isReadChannel(c), c).toBe(false);
    }
  });
});
