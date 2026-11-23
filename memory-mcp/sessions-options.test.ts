// BTL-260：升级前起的 claude 的 MCP 配置里是 BUTLER_* 变量（BUTLER_SCOPE=butler）。butler 是旧名字。
import { describe, expect, it } from "vitest";
import { sessionsOptionsFromEnv } from "./sessions-options";

const dirs = { SHIPHERD_CONTROL_REQUESTS: "/c/req", SHIPHERD_CONTROL_RESULTS: "/c/res" };
const oldDirs = { BUTLER_CONTROL_REQUESTS: "/c/req", BUTLER_CONTROL_RESULTS: "/c/res" };

describe("sessionsOptionsFromEnv with pre-rename variables", () => {
  it("reads the controller scope, ticket, feature, session and language from BUTLER_*", () => {
    expect(sessionsOptionsFromEnv({ ...oldDirs, BUTLER_SCOPE: "butler", BUTLER_SESSION: "s1", BUTLER_LANG: "en" })).toEqual({
      scope: { shipherd: true }, lang: "en", from: "s1", requestsDir: "/c/req", resultsDir: "/c/res",
    });
    expect(sessionsOptionsFromEnv({ ...oldDirs, BUTLER_TICKET: "T-1" })?.scope).toEqual({ ticketKey: "T-1" });
    expect(sessionsOptionsFromEnv({ ...oldDirs, BUTLER_FEATURE: "7" })?.scope).toEqual({ featureId: 7 });
  });

  it("prefers the new names", () => {
    expect(sessionsOptionsFromEnv({ ...dirs, SHIPHERD_TICKET: "NEW-1", BUTLER_TICKET: "OLD-1" })?.scope).toEqual({ ticketKey: "NEW-1" });
    expect(sessionsOptionsFromEnv({ ...dirs, SHIPHERD_SCOPE: "shipherd" })?.scope).toEqual({ shipherd: true });
  });
});
