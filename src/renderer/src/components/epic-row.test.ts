import { describe, expect, it } from "vitest";
import type { EpicView, FeatureView } from "../../../shared/types";
import { ButlerError } from "../api";
import { STRINGS } from "../strings";
import { epicErrorText, epicOpenError, featuresOutsideEpics } from "./epic-row";

describe("epic wording for errors", () => {
  it("does not reuse the ticket wording when an epic session cannot open", () => {
    for (const reason of ["no_ticket", "no_repo"]) {
      for (const S of [STRINGS.zh, STRINGS.en]) {
        expect(epicOpenError(reason, S)).not.toBe(S.openErrors[reason]);
        expect(epicOpenError(reason, S).toLowerCase()).toContain("epic");
        expect(epicOpenError(reason, S).toLowerCase()).not.toContain("ticket");
      }
    }
  });

  it("keeps the shared wording for the other open failures, and shows an unknown reason as it is", () => {
    expect(epicOpenError("claude_missing", STRINGS.zh)).toBe(STRINGS.zh.openErrors.claude_missing);
    expect(epicOpenError("odd", STRINGS.zh)).toBe("odd");
  });

  it("does not call an epic a feature when creating, renaming or archiving it fails", () => {
    for (const code of ["invalid_name", "workspace_taken"]) {
      for (const S of [STRINGS.zh, STRINGS.en]) {
        const text = epicErrorText(new ButlerError(code, "main"), S).toLowerCase();
        expect(text).toContain("epic");
        expect(text).not.toContain("feature");
      }
    }
  });

  it("says the terminals may be the epic's or its features' when archiving is refused", () => {
    for (const S of [STRINGS.zh, STRINGS.en]) {
      const text = epicErrorText(new ButlerError("sessions_open", "main"), S).toLowerCase();
      expect(text).toContain("epic");
      expect(text).toContain("feature");
    }
  });

  it("falls back to the shared wording, then to the message from the main process", () => {
    expect(epicErrorText(new ButlerError("not_git_repo", "main"), STRINGS.zh)).toBe(STRINGS.zh.createErrors.not_git_repo);
    expect(epicErrorText(new ButlerError("epic_archived", "main says"), STRINGS.zh)).toBe("main says");
    expect(epicErrorText(new Error("boom"), STRINGS.zh)).toBe("boom");
  });
});

describe("featuresOutsideEpics", () => {
  const feature = (id: number, epicId: number | null) => ({ id, epicId }) as FeatureView;
  const epic = (id: number) => ({ id }) as EpicView;

  it("leaves out a feature that is listed under an epic", () => {
    expect(featuresOutsideEpics([feature(1, null), feature(2, 7), feature(3, 8)], [epic(7), epic(8)]).map((f) => f.id)).toEqual([1]);
  });

  it("keeps a feature whose epic is not on the list, so that it never disappears from the sidebar", () => {
    expect(featuresOutsideEpics([feature(2, 7)], []).map((f) => f.id)).toEqual([2]);
  });
});
