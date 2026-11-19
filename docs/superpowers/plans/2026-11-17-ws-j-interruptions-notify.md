# Workstream J plan: fewer interruptions, outside notifications

The design is `docs/superpowers/specs/2026-11-17-ws-j-interruptions-notify-design.md`. Every task is test-first: write the failing test, make it pass, then run `pnpm typecheck && pnpm lint && pnpm test` before the next task.

1. **Classifier.** `src/main/permissions/classify.ts` plus a test:
   - the write-command corpus and hostile rules must all be refused;
   - the read-only examples must give the expected rule forms;
   - `matchesRule` follows Claude Code's prefix and exact semantics.
2. **Transcript scan.** `src/main/permissions/scan.ts` plus a test (a fake transcript tree in a temp dir):
   - thresholds of 3 runs across 2 sessions;
   - rejections exclude the rule;
   - errors don't count;
   - the slug comes from `cwd`;
   - size and age limits hold.
3. **Storage and service.**
   - Migration with the `permission_profiles`, `auto_choices`, `choice_defaults` and `notification_log` tables (appended last).
   - `PermissionProfileRepo` and `PermissionProfileService` for candidates, confirm, dismiss, remove, `rulesForDirs` and model explanations through the router.
   - Tests cover the `isSafeRule` re-check on store and use, and the `permissionProfiles` switch.
4. **Session settings.** `projectMcpApprovalSettings({profileRules})` plus a test, then wiring in `index.ts`.
5. **Measurement.** The activity-monitor `onTool` hook plus profile-hit events (`interrupt_auto_resolved`); register `stuck_fix_opened`, `pr_risk_high` and `pr_ready` in `METRIC_KINDS`; `openFix` records its event.
6. **Choices.**
   - `ReportKind` gains `choice`, and `ask_user` gains `recommended` (control, sessions-server, control-handler).
   - Inbox: `choice` reports go to `auto_choices`; default answers are applied in `ask`.
   - Guide paragraphs for the choice and self-serve rules, behind their switches.
   - Tests for each switch.
7. **Effect page.** `interruptReductionSince`; `buildOverview` gains `interruptCompare`; render it in `EffectPage`.
8. **Notifications.**
   - `PrivacyGateway.postWebhook` (HTTPS-only test against a local server; loopback `http` allowed).
   - Webhook URL store.
   - `Notifier` with event filter, quiet hours, 60-second batching, the details opt-in, the 4.8 switch and the log.
   - Sources: inbox ask, the `recordEvent` wrapper, the PR watcher's `onHumanComment`.
9. **Export/import.** The `permissions` section (zod refine through `isSafeRule`, pending on import) plus a test.
10. **Settings and IPC.**
    - Editable settings, defaults, normalising, both configuration docs.
    - IPC channels plus their `interventions.ts` classification; preload `api`.
11. **UI.**
    - Settings tab 「打断与通知」: profiles, choice rule and defaults, auto-choice review, self-serve, webhook.
    - Wizard step 「权限档案」.
    - Strings in both languages.
12. **E2e.** A fake transcript in the sandbox's Claude config dir; walk the wizard step, confirm, and see the rule in Settings. Update `completeWizard` and the step count.
13. **Review and merge.** Opus review, fixes, the merge lock, the PR, the merge, the report.
