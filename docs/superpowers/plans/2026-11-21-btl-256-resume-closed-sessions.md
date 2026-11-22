# BTL-256 plan

Design: `docs/superpowers/specs/2026-11-21-btl-256-resume-closed-sessions-design.md`.

1. Migration + SessionsRepo: `user_ended_at`, `term_open_at`; `setUserEnded`, `markTermOpen`, `clearTermOpen`, `takeTermOpen` (read + clear all). Repo tests.
2. `src/main/sessions/resumer.ts`: `resumable()` pure predicate; `Resumer` with `request(head, why)` (idempotent, admission, transcript check, open, wait for start, failure bookkeeping, receipts), `status(head)`, `delivered(m)`, `opened(head)`; `restartOrder()` pure sort. Unit tests first (TDD): closed + message → resumed; no memory → waiting_memory, no retry within 60 s; user ended → no resume; concurrent requests → one open; failures → wake_error, retry limit; delivered receipt once.
3. Mailbox: optional `delivered?(m)` dep called from `markDelivered`. Test.
4. index.ts wiring: `wake` → hibernator or resumer; pty `opened` → markTermOpen + clear userEnded + resumer.opened; exit (not quitting) → clearTermOpen; `ptyKill` IPC → setUserEnded; startup → takeTermOpen and, when the setting is on, `resumeAfterRestart`.
5. Control: feature `send_message` awaits `resumer.request` when state is closed and returns `wake`; `list_sessions` rows get `wake`; Butler `openAndSend` honours user-ended and reports `wake`. Strings zh/en. Tool descriptions in `memory-mcp/sessions-server.ts`. Tests.
6. Setting `autoResumeAfterRestart` (EDITABLE_SETTINGS, defaults, layout basic, BasicSettings checkbox, renderer strings), docs/configuration(.zh-CN).md.
7. e2e `e2e/resume.spec.ts`: closed ticket session resumed by coordinator message; user × → ended_by_user; restart with setting on resumes. Memory-short case via `BUTLER_E2E_AVAILABLE_MB`.
8. typecheck, lint, test, e2e; opus review; PR.
