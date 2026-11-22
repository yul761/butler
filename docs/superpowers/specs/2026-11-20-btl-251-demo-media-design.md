# BTL-251 Demo media recorder — design addendum

Date: 2026-11-21. Ticket: BTL-251, part of the public-launch round. The README rewrite (BTL-252) uses what this produces; this ticket does not touch the README.

## Goal

One command, `pnpm demo:record`, re-records the README hero animation and the feature screenshots from the real app, in English and Chinese, light theme. It runs locally on each release, not in CI.

Outputs (contract `[contract:demo-media]` in the epic memory): `docs/media/demo.gif`, `demo.zh-CN.gif`, `your-turn.png`, `epic.png`, `ticket.png` and their `.zh-CN.png` twins. How to re-record: `docs/demo-media.md` (+ `.zh-CN.md`).

## Decisions

1. **Reuse the e2e sandbox, not a separate harness.** The recorder is a Playwright file (`e2e/demo/record.demo.ts`) with its own config (`playwright.demo.config.ts`, `testMatch: *.demo.ts`). It uses `makeSandbox` / `launch` from `e2e/fixtures.ts`, so the isolation guard (fake `claude` only, sandbox HOME, BUTLER_HOME, CLAUDE_CONFIG_DIR) applies unchanged. The real `~/.butler` and `~/.claude` are never touched. The main e2e config only matches `*.spec.ts`, so CI never runs it.

2. **Fictional data in one file.** `e2e/demo/demo-data.ts`: a note app "Fernleaf" building an "Offline mode" epic (离线模式). Repos `fernleaf-notes/web`, `fernleaf-notes/sync-api` (not `fernleaf`: that is a real GitHub account, caught in review); features Local storage / Sync / Polish; tickets FERN-101…105; PR #42. No company, person or real repo names, and a unit test checks for a few known ones. Keys, repos and PR number are the same in both languages, only the text differs.

3. **Scripted fake claude (`FAKE_CLAUDE_SCRIPT`).** Mailbox delivery wraps every message in a header, so the fake `claude`'s `/fake-*` commands can't be sent from another session. Instead the fake `claude` takes an optional JSON script: a banner replacing the "fake claude ready" and "mcp:" lines, and rules `{ when, reply?, then?: [{ after, line, say? }] }`. A rule fires when an input *contains* `when`. Its `then` steps are fed back as inputs after a delay: tool calls, `/fake-bash` to keep working, `/fake-mcp ask_user`. Scripted steps are not written as user messages, run no UserPromptSubmit and never match rules, so they can't loop. Without the env var nothing changes for the e2e suite.

4. **The recorder plays the epic coordinator.** It reads the coordinator's `butler-sessions` MCP config and calls `create_feature`, `create_ticket`, `start_session` and `send_message` over stdio as that session (`BUTLER_SESSION`). That is the real path a coordinator uses, so the UI shows exactly what users see.

5. **"Click merge" = Open PR, then GitHub reports merged.** Butler has no merge button (merging always needs your click on GitHub). The GIF clicks **Open PR** with `shell.openExternal` stubbed in the main process. The fake `gh` fixture then flips PR #42 to MERGED. A green open PR is re-read only every 5 minutes, but `soonTicket` re-reads at once when one of the ticket's sessions stops. So the recorder (as coordinator) sends FERN-101 "your PR was merged"; the session replies and stops, and the card goes away a second later.

6. **Animation from screenshots, not video.** Playwright video for Electron is poor quality and records the waits. `Recorder` takes a CSS-scale screenshot about every 100 ms during the scenes and is paused across waits (the PR watcher, sessions starting). `ffmpeg` joins the frames with their real durations (concat demuxer), at 10 fps, 1280 px wide, with a 128-colour diff palette and rectangle diffs. Result: about 30 s, about 0.35 MB. The recorder fails at 5 MB or more. `ffmpeg` is a documented prerequisite, checked up front.

7. **Captions and pointer are drawn into the page** (an injected overlay), because screenshots have no OS cursor. They are hidden before the stills. The same overlay rewrites the sandbox home prefix in text nodes to `~`, so headers read `~/code/fernleaf-notes-features/Offline mode` instead of `/private/var/folders/...`. The repos really live under the sandbox HOME's `code/` folder, so this shows the same path a real user would see.

8. **No transient states on camera.** Right after `start_session`, sessions briefly read "stopped, waiting for you" until the task arrives. That stretch isn't recorded: capture resumes once FERN-102 shows as working and FERN-103's question is on the board. After you answer, FERN-103 doesn't reply and stop; it keeps working (edit, then a long test run).

9. **Stills come from the same run.** While capture is paused (both cards on **Your turn**), the recorder saves `your-turn`, `epic` (overview, feature blocks) and `ticket` (FERN-101 overview with the merge card) at device scale. Then it returns to **Your turn** to continue.

10. **macOS/Linux only.** The fake `gh` is an sh wrapper (`resolveGh` only accepts `gh.exe` on Windows), so the recorder skips on Windows and the docs say so. The unit tests (`e2e/demo/demo.test.ts`, added to the vitest include) run everywhere, including the fake-claude script test, which uses node only.

11. **Window size.** `setContentSize(1280, 768)` so the page is 1280×768 on every platform (PNGs are 2× on Retina).

12. **Wizard steps.** BTL-249 shortens the first-run wizard. The recorder's wizard helper clicks **Next** until **Finish** shows instead of counting steps.

## Found on the way

- The turn cards said "just now ago" / 「刚刚前」 for anything under a minute old, which would be visible in every screenshot. `home-view.ts` now uses `agoText`: under a minute it says "just now" / 「刚刚」, and review cards say "asked just now" / 「刚刚请你」. Unit test in `home-view.test.ts`.

## Not in scope

- README changes (BTL-252 embeds the media).
- Recording in CI, or on Windows.
