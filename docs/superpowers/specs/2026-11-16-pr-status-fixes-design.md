# PR status and PR progress: fix everything the audit found

Date: 2026-11-16. Branch: `fix/pr-status` (from main c529982, 2.0.0). Target release: 2.1.0.

The user saw two things in the app:
- past tickets show 自我 review as 跳过;
- a feature whose PRs are all merged shows none merged.

They asked for an overall self-audit of PR status and PR progress, and for **every problem found to be fixed, however small**, followed by a release.

Two read-only audits ran against the code and the user's real DB (`~/.shipherd/app.db`): one on capture (C), one on derivation and display (D). The previously deferred review-lessons follow-ups (L) are in scope too.

Note: the user's installed app is still 1.9.0 (DB `user_version` 20), not 2.0.0.

## Core change: PR progress is per PR, not per ticket repo

Today a ticket repo has exactly one `pr_watch` row, found only by `gh pr view <ticket branch>`. Once that row is merged or closed it is never read again. The derivation freezes at the first merge.

Real data breaks all of this:
- BTL-190 merged #25 and #26 on `feature/BTL-190`, then #27 / #28 / #29 on other branches from its coordinator sessions.
- BTL-151 had #16 and #17, BTL-180 had #19, #20 and #21, and REMI-001 had remi-web #1 and #2. Handoffs recorded all of them.

Decisions:
1. **A ticket owns a set of PRs.** A new table (e.g. `ticket_prs`) keyed by ticket plus PR URL holds every PR linked to a ticket. Each PR row has:
   - repo (`repo_id` when the slug matches one of the ticket's repos, otherwise null with the slug kept for display), number, url, head branch;
   - state, ci, review, opened_at, merged_at, closed_at;
   - the link source (`branch` | `handoff` | `merge_gate` | `backfill`) and checked_at.

   The live per-PR watch state that `pr_watch` holds today (head sha, failed checks, delivered key) moves to, or is re-keyed to, per PR. The implementation plan decides the exact table shape and migration, and must keep CI delivery, review-comment delivery, prHandoff refresh, merge-gate and lessons `onMerged` working.
2. **Sources of links:**
   - **Ticket branch:** `gh pr list --head <branch> --state all`. It finds sequential PRs on the same branch.
   - **Handoff `prs` URLs:** on ingest and in backfill.
   - **Merge gate:** `merge_holds` rows. When `ticket_key` is null, resolve it through `session_id` → sessions.ticket_key.
   - **Watcher:** any PR it observes.
3. **Watching:**
   - **Open PRs:** every open linked PR is polled by number/URL.
   - **Ticket branches:** each ticket branch is re-checked for a new PR in any of these cases:
     - its session is open, where a coordinator session counts for every repo of its ticket (C-V4);
     - on Stop of any session of the ticket, including coordinators, which triggers `soon()` for all its repos;
     - on a slow tick (no `neverRead` latch, C-S2).
   - **Merged/closed PRs:** these are terminal per PR, not per repo.
4. **One-off backfill at startup**, once, for every ticket including archived ones:
   - for each ticket repo, run `gh pr list --head <branch> --state all`;
   - collect handoff PR URLs (`gh pr view <url>` for the state and real mergedAt);
   - collect merge_holds rows.

   This seeds PR rows and `merged`/`closed` stage events at the **real** mergedAt/closedAt. It should be rate-limit friendly, never block startup, and be idempotent if interrupted.
5. **Stage events are scoped to a PR.**
   - PR events (pr_opened, ci, review, merged, closed, push) carry the PR number.
   - Repo-level events (first_commit, skill, report) are assigned to the PR whose window contains them. The window runs from the previous PR's merge/close in that repo to this PR's merge/close; the open/latest PR gets everything after.
   - Skill events also record the session's git branch when it is known, and branch beats the window.
   - Events after a PR's merge never land on it (D-11, C-V6).
6. **Display:**
   - The ticket tab shows one progress row per PR, newest first, plus an "in progress, no PR yet" row when the branch has commits but no PR.
   - Feature and epic tables count a ticket as merged when all of its linked PRs are merged/closed and at least one is merged, **or** the ticket status is `merged_pending_followup` or `done` (D-6).
   - Archived tickets are included, with an archived tag (D-7).

## Derivation fixes (`src/main/prwatch/pr-stages.ts` and friends)

- **D-1 / C-V5a, untracked:** persist the time skill tracking became active (the first time the current hook is seen, a settings key). For work before that time, design and self_review are `unknown`, not `skipped`. Base the decision on the event or PR time, not on "hook is current now".
- **D-2 / C-V10, subagent reviews count:**
  - Map `subagent-driven-development` and `receiving-code-review` to the review category, and keep `requesting-code-review`.
  - Add a PostToolUse matcher for the Agent/Task tool. A dispatch whose description or subagent_type matches `/review/i` records a review skill event (name like `agent:<description>`).
  - Keep it best-effort and cheap.
- **D-3, review after the PR opens:** a review skill or review agent seen after the PR opened, but before merge, in the current round marks self_review done if it was skipped, unknown or todo.
- **D-4 / C-V5b, real merge times:** the synthetic merged event uses the real `mergedAt` from gh (stored on the PR row), else the merge_holds `released_at`, else `checked_at`. It is never later than `checked_at` and never pulls later events in.
- **D-5, no invented states:**
  - With no history, stages with no evidence are `unknown`.
  - Seed ci from the PR row (`passing` → done, `failing` → failed) and peer_review from review (`approved` → done, `changes_requested` → failed).
  - Pass `row.ci` / `row.review` into the derivation.
- **D-8, standing change request:** an APPROVED from someone while another reviewer still has CHANGES_REQUESTED keeps peer_review failed. Same rule as the DISMISSED path.
- **D-9, reopened PRs:** a closed PR that is reopened unfreezes. `closed` follows the PR's current state.
- **D-12, approval across pushes:** follow GitHub. An approval stands across pushes and CI rounds until it is dismissed or superseded by CHANGES_REQUESTED. Make F1 and F2 consistent, and update the tests and spec comment.
- **D-13, merged despite changes requested:** if the PR is merged while a CHANGES_REQUESTED stance stands, peer_review shows `failed` (not skipped), and merge shows done.
- **Suspicions to fix as well:**
  - **Mixed clocks:** order review events by observation time where the push/ci events use observation time, which matches the DISMISSED learning (C learning: DISMISSED keeps the original submittedAt).
  - **Late first_commit:** if `first_commit.at` is after `pr_opened`, treat dev as started at min(first_commit, pr_opened). The CI before it must not be dropped.
  - **Feature-level design:** upper design counts if it is before the ticket's first commit (or first PR), not strictly before ticket creation.
  - **Stance key:** reviews with no login are keyed by review id.

## Capture fixes (`src/main/prwatch/*`, `src/main/tickets/gh.ts`, handoff ingest, hook)

- **C-V7, CI blip:**
  - On a gh failure, keep the previous ci value and flag the error separately.
  - A previous `unknown` never counts as a ci change, so there are no duplicate "CI passed" events.
- **C-V8, ticket status:**
  - Remembered merged PRs must not override an explicit `active`/`in_review` from the model.
  - An open linked PR (from the new PR set) makes the ticket in_review.
  - A ticket with sequential PRs can return to active.
- **C-V9, duplicate PRs:** dedupe handoff PRs within a repo by number when either URL is empty, keeping the entry that has a URL. Apply this in `pr-memory.ts` and `pr-handoff.ts`.
- **C-S1, Codex reviews:** reviews from AI reviewers (Codex connector, Copilot) count as AI review, consistently, and are not dropped as bots. Check how Copilot is treated today and make Codex match.
- **C-S3, branch changes:** after a branch change, rows for the old branch stop feeding `prHandoff` / CiDelivery. Re-key or clean them up.
- **C-S4, removed worktrees:** when `worktree_removed_at` is set, workDir falls back to the repo path for gh/git calls.
- **C-S5, lost `onMerged`:** it must fire even if a later step throws. Record merged-handled per PR, and retry on the next round.
- **C-S6, discovered sessions:** skill events from discovered sessions attached to a ticket are recorded.
- **C-S7, polling:** polling is driven by per-PR state, not by a ticket-level "handoff has an open PR".

## Display fixes (`src/renderer/...`, `styles.css`)

- **D-14, contrast:** in the light theme, stage text meets 4.5:1 for done, active, failed and muted on panel. The dark theme already passes.
- **D-14, empty states:**
  - A feature with no tickets says so; it does not say "还没有仓库".
  - Tickets with no repos still appear, with a note.
  - An epic feature with no rows does not show "0/0 已合并".
- **D-14, PR links:**
  - The PR number is a clickable link opening the PR. Use a main-process openExternal with the same https + github-host check as lessons `openSource`; share that helper.
  - PRs in repos the ticket doesn't list show the slug.
- **D-11, reports:**
  - Reports go in the timeline of the PR whose window contains them.
  - They show without a stage prefix.

## Review-lessons follow-ups (L), all fixed

- **gh availability:**
  - `ghBinary()` falls back to `"gh"`, so on macOS/Linux `no_gh` never shows.
  - Detect real availability, for example an existence check or a cached `gh --version`.
- **`daily()` failures:** when every repo failed, don't record "ok". Retry on the next schedule trigger.
- **Page counts:** skipped and failed analyses notify, so the page counts refresh.
- **`pendingCount`:** use `COUNT(*)`, not N+1 queries.
- **`state()` writes:** `state()` must not `upsertRepo` every known path on every refresh. Only upsert when something changed or is missing.
- **`knownRepoPaths`:** exclude archived tickets' repos, or show them separately. Repo paths that don't exist on disk are skipped.
- **Non-git paths:** use an `existsSync` check before spawning git, and cache "not a git repo" for paths that exist without `.git`.
- **Confirming lessons:** confirm only applies to pending lessons, so a rejected lesson can't be revived.
- **Product ops:**
  - A product op on a missing product returns not_found.
  - `addToProduct` on a missing product returns not_found, not a generic FK error.
- **Small cleanups:**
  - `repo-<slug>` error keys are unique per product row;
  - clear `sel` after its product is deleted;
  - remove unused strings (`lessonsProducts`, `lessonsProductScope`).
- **Test gaps, all filled:**
  - openSource: enterprise host accepted, `https://github.com@evil.com` rejected, lookalikes;
  - tail reader: empty file and multi-byte cut;
  - `defaultGit`: status 2 vs other errors;
  - the rate-limit pause timer;
  - pr-watcher with a throwing onMerged;
  - the id-asc tie-break;
  - the ticketless stuck-session branch;
  - validator valid-path cases;
  - the bad_status branch and the disable/enable round trip;
  - the 4000/1500 caps;
  - the prompt test cast;
  - component tests for LessonsPage select/prune/prefill where feasible;
  - the cursor-overlap test made a real test (mock returns the PR only for the overlapped `after`).
- **fixRange:** if `fixRange` returns null after a rebase or force-push, fall back to the PR's full diff range or skip that section explicitly.
- **Item headers:** item headers in the material are capped.

## Out of scope

Non-Shipherd terminals; exporting lessons to repos (decided earlier: lessons stay in Shipherd).

## Verification

- typecheck and eslint (`src e2e hook`);
- the full vitest suite;
- build plus the full Playwright run;
- e2e coverage for:
  - a ticket with two sequential PRs on its branch plus one PR on another branch linked via handoff, showing three rows and correct feature counts;
  - backfill of an old merged ticket showing merged with unknown design/self_review.

Run against a copy of the real DB once (read-only copy in the scratchpad) to confirm feature 1 shows 5/5 merged and BTL-190 lists #25 to #29.
