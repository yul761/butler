# Workstream W: CI results that never reach the session (design)

Date: 2026-11-18. Master design: `2026-11-17-butler-3-design.md`. Base: `main` after #38.

Users repeatedly saw Butler tell a session "I will hand you the CI result", then nothing arrived and the session sat on "waiting for CI" until someone noticed. This addendum records the root causes found in the code and in a real database, and the fix.

## 1. Root causes (verified)

Evidence from a real ticket with seven PRs (#31–#38) worked on by child sessions, each in its own git worktree on its own branch:

- `ticket_prs.delivered_key` was empty for every row, including PRs that had passed CI and been merged. The main log had no `ci delivery` line at all: every result was dropped before any code path that logs.
- `ticket_repos.branch` for the ticket was the shared checkout's branch (`feature/<ticket>`); every PR head branch was something else.

The causes, in the order they bite:

1. **Delivery is gated on the shared checkout's branch.** `CiDelivery.pending()` returns `null` for a PR row unless `head_branch === ticket_repos.branch`. Any PR opened from another branch is never delivered: child sessions in worktrees, a session that ran `git checkout -b` in the ticket repo, or a ticket whose recorded branch is stale (Butler only writes `ticket_repos.branch` when the ticket is created or edited). This alone explains "many times".
2. **The recipient is "the first open session of this ticket and repo".** `sessionFor` loops over open terminals and returns the first non-coordinator head with the same `ticketKey` and `repoId`. With several sessions on one repo (one PR each) the result goes to whichever terminal opened first, even if (1) is fixed.
3. **Every "don't deliver" path is silent.** `pending()` returns `null` for nine different reasons, `tryDeliver` returns early when there is no session, the session is busy or the guard blocks. Only `blocked`/`timeout`/thrown deliveries are logged. Nothing in the UI shows that a result is waiting.
4. **PRs on other branches are only linked by luck.** `ticket_prs` rows come from four sources: `gh pr list --head <ticket branch>` (branch), the PR list of a stored handoff (handoff), a merge-gate hold (merge_gate) and the one-off backfill (which also lists the ticket branch only). A PR on any other branch is linked only if a session happens to run `/handoff` after opening it, or the PR goes through the merge gate. #34 never did either, so Butler never saw it. In addition, `pruneStale` deletes open `branch`/`backfill` rows whose head branch is not the ticket branch, so even a correct link from another branch would be removed on the next round.

Checked and not a cause of a permanent hang (they are logged now, see 3.3):

- `ci` going straight from `pending` to `merged`: the PR is closed, nobody waits for it; not delivered by design.
- `head_sha` null with a settled `ci`: never delivered (`settledRow`); happens only if `gh` omits `headRefOid`. Now logged as `no_sha`.
- Guard never lets the result through (user typing, draft, screen needs user, needs-you): retried on every round and every Stop. Now logged and surfaced after 30 minutes.
- `deliver` returning `blocked` / `timeout` / `exited`: retried on the next flush; same as above.

## 2. Decisions

- **The PR belongs to the session that pushed its branch or opened it.** Butler records that from the hook, not from the checkout. The recipient order is: the owner, if its terminal is open; else the one open non-coordinator session of the ticket and repo whose recorded `git_branch` is the PR's branch (on the ticket's own branch, where several sessions can share the checkout, the first of them); else, only for a PR on the ticket branch with no owner, the single open session when its branch is not known yet. A closed owner is replaced only by a session started on the PR's branch (the user opened a new session to wait for CI), never by a session on another branch (that is how results reached the wrong session). Child sessions in worktrees on their own branches never receive a ticket-branch PR by default. Otherwise the result is not delivered and the reason is recorded.
- **The coordinator can own a branch.** If the coordinator itself pushed a branch, it gets that branch's CI. The old exclusion of coordinators stays for the fallbacks.
- **Owner records come from `git push` and `gh pr create` in Bash PostToolUse and PostToolUseFailure** (in `git push && gh pr create` a failing `gh` still leaves a successful push). The hook parses the full command with `classifyShip` before trimming it (a long `git commit -m "$(cat <<EOF …)" && git push` would not be recognised after truncation) and writes an inbox envelope only when it finds one of those two commands. The envelope carries the parsed `ship` list, the command (truncated, for logs), `cwd`, `BUTLER_SESSION`, and for `gh pr create` the PR URLs printed. Main resolves the directory (`cd` / `git -C` relative to `cwd`; `~` / `$HOME` expanded; Git Bash `/c/...` mapped to `C:\...` on Windows; if the resolved directory does not exist, `cwd` itself), the branch (each push target, or the directory's current branch for `HEAD` / no refspec; tag refs and version-like names are skipped), the ticket repo (by the directory's main repo root, matched against each ticket repo path or that path's own main repo root, so a ticket repo that is itself a worktree matches), and stores `(ticket, repo, branch) → session, dir`. The newest push wins, except that a coordinator push (rebase + force-push of a child's branch) does not take the branch from a child whose terminal is still open. Only the last PR URL printed is linked, and only if it belongs to that repo.
- **Owned branches are watched for PRs.** Each PR watcher round lists PRs on owned branches (other than the ticket branch, recorded in the last 14 days, at most every 5 minutes unless forced) in the owner's directory and links them (`source = 'branch'`). A branch is no longer listed once a linked PR on it is open or was merged/closed after the latest push; a new push starts listing again. Only open PRs and PRs opened at most a day before the latest push are linked, so a reused branch name does not pull in old merged PRs. `gh pr create` URLs are linked immediately. `pruneStale` keeps rows whose branch is owned.
- **Every skip is logged once per reason change.** `ci delivery <ticket>#<n> (<sha7>:<ci>) not delivered: <reason>`; the same reason for the same result is not repeated every 15 s round. Reasons: `no_repo`, `no_sha`, `no_session`, `owner_closed`, `unowned` (open sessions exist but none can be identified as the PR's), `busy_delivering`, `guard:<block>`, `deliver:<result>`, `failed`.
- **Undelivered for 30 minutes → a notice on the Now page** ("CI result not delivered", with the PR, the reason and **Resend** / **Open** buttons). Only results that someone was promised and that a resend could help with are shown: a recognised recipient that cannot take it right now, or `unowned` for a PR on the ticket branch. `owner_closed`, `no_session`, `no_repo`, `no_sha` and `unowned` off the ticket branch (a related or colleague PR, the same PR linked to a second ticket) are only logged. The clock is in memory (restart resets it; a restart also re-delivers on the first round, so the result usually goes out then). Resend clears the logged reason and tries again immediately through the same guard; the button reports the outcome.
- **Migration (append-only):** one new table `branch_owners`. `ticket_prs` and `branch_watch` are unchanged.

## 3. Design

### 3.1 Recording ownership

- `src/shared/gate-command.ts`: `classifyShip(command)` → `ShipCommand[]` (`{ kind: "push"; dir; branch: string | null } | { kind: "pr_create"; dir; head: string | null }`, in order), reusing the tokenizer. Dry runs, deletes and tag/mirror pushes are not pushes. `branch` is the remote branch of the first refspec (`HEAD` / no refspec → null).
- `project-mcp.ts`: PostToolUse gets one more group `{ matcher: "Bash", command: <hook> }` (no mode → envelope). The hook (`butler-hook.ts`) drops Bash PostToolUse payloads that are not `classifyShip` matches and trims the rest to `{ hook_event_name, session_id, tool_name, tool_use_id, cwd, tool_input: { command }, pr_urls }` (command capped at 2000 characters, URLs from `tool_response.stdout`).
- `src/main/prwatch/branch-owners.ts`: `shipFromEnvelope(env)` (pure parse; headless envelopes ignored) and `BranchOwnership.record(ship)` (resolve, store, link, `prWatcher.soon(repoId)`). The ticket repo is the one whose path equals the directory's main repository root (`git rev-parse --git-common-dir`, compared with `samePath` and then after `realpath`). A directory in another repository is **not** attributed to the session's repo (that would mislabel a branch). Each failure to resolve is logged with its reason.
- `src/main/db/branch-owners-repo.ts`: `branch_owners (ticket_key, repo_id, branch, session_id, dir, at, PRIMARY KEY (ticket_key, repo_id, branch))`.

### 3.2 Recipient

`CiDelivery` gets `recipient(ticketKey, repoId, branch)` instead of `sessionFor`, implemented by the pure `pickRecipient({ owner, ownerOpen, open, ticketBranch, branch })` so it can be tested without terminals. `open` are the open heads of the ticket and repo; the owner id is followed through `/clear` (`sessions.head`) and its terminal found with the same lookup the merge gate uses.

### 3.3 Delivery state

`CiDelivery` keeps, per result (`pr:<id>` / `branch:<repoId>` plus the delivery key), the first time it was seen undelivered, the last reason and the intended recipient. A new commit or a new CI state restarts the clock; results that are delivered, closed or running again are forgotten on the next flush. `undelivered()` returns the ones older than 30 minutes with a reason someone can act on; `resend(item)` forgets the logged reason, calls `tryDeliver` and returns the outcome (`sent` or the reason). `ciNotices` turns them into `ci_undelivered` notices; main re-renders the Now page when that list changes (checked after every flush, i.e. every watcher round). IPC `ci:resend` takes a validated `CiItemRef`.

### 3.4 Windows

The recipient goes through the same `pty.deliver` with `singleLine` on Windows. Command directories are resolved with `path.win32` on Windows, Git Bash drive paths (`/c/...`) are mapped to drive letters, and `~` / `$HOME` are expanded (`resolveShipDir`, unit-tested with Windows inputs on every platform). Repo paths are compared with `samePath` (case-folded on Windows) and then after `realpath`; the hook's command parsing already handles Windows paths and `\r`.

## 4. Tests

- `ci-delivery.test.ts`: a PR on a worktree branch with an owner is delivered to the owner (fails before the fix); two sessions on one repo, each owning a branch, each gets only its own PR; owner recorded but closed → not delivered to the other session; every skip reason is logged once; undelivered after 30 minutes appears in `undelivered()`, resend delivers it.
- `branch-owners.test.ts`: `classifyShip` cases; recording from a push in a worktree, from `gh pr create` with a URL (the #34 case: the PR gets linked), unknown directory is logged.
- `pr-watcher.test.ts`: owned branches are listed and their PRs linked; `pruneStale` keeps owned rows.
- `butler-hook.test.ts`: Bash PostToolUse that is not a push is dropped; a push is trimmed.
- e2e: a fake session pushes a branch in a worktree; the CI result reaches that session.
