# BTL-243 plan: remove the personal LLM API

Design: [2026-11-20-btl-243-remove-personal-llm-design.md](../specs/2026-11-20-btl-243-remove-personal-llm-design.md).

Each task ends with `pnpm typecheck` green for the files it touched; the full `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` runs at the end.

1. **Migration (test first).** Add a migration test: seed `llm_api_key`, a webhook secret, `llm*` settings, a term and an audit row on the previous schema version, migrate, and check that only the LLM data is gone and the webhook secret stays. Then append the migration.
2. **Move what stays.** `webhook.ts` → `src/main/notify/`, `loopback-mcp.ts` → `memory-mcp/loopback-http.ts`, `SecretBox` + `safe-storage.ts` → `src/main/notify/secret-box.ts`, `statecore-env.ts` → `src/main/memory/`, the fake server → `src/main/testing/loopback-recorder.ts` (recorder only). Update the importers. The notifier posts through `sendWebhook` directly.
3. **Lint.** Drop the gateway directory exception; add the three per-file allowances. Update `egress-lint.test.ts` first so it fails: a probe in `src/main/gateway/` is now rejected; each allowed file accepts only its own import and rejects the rest. Update `egress-directives.test.ts`.
4. **Delete the gateway and its users.** gateway, provider, budget, key-store, status, types, their tests; `AuditRepo`, `TermsRepo`, `llm-repos.test`; `shared/llm.ts`; the distiller wiring in `index.ts`, `DailyDeps.distill`, `MemoryService.distill`/`nightlyDistill` and their tests; `llmConfig` and the `llm*` cases in `settings-values.ts`; defaults in `settings-repo.ts`; the IPC channels, handlers, validators and `interventions.ts` lists. `auditCutoff` becomes `now − days` in `src/main/external/`.
5. **Renderer.** Delete `PrivacySettings`, `privacy-form` (move `formatUsd` to `format.ts`), the privacy group in `settings-layout.ts` and `AdvancedSettings`; put `auditRetentionDays` into `ExternalActionSettings`. Delete wizard step 4. Audit page: outward actions only. Remove the strings in both languages.
6. **Memory MCP (test first).** Split `MEMORY_TOOLS` into the upstream copy and Butler's overrides; update the contract test to check the upstream copy word for word and the overrides exactly. Change the `remember` consolidate reply and drop `pending` from `facts`. Replace `memory-mcp/entry.ts` with a stdio loop over `MemoryServer` (`backgroundDigest: false`); hub-entry also passes `backgroundDigest: false`. Update `bundle.test.ts` (consolidate reply, tool text) and keep the model-free proofs.
7. **E2E.** Update the wizard walk in `e2e/fixtures.ts`, the audit page in `butler.spec.ts`, and anything else that opens the privacy group.
8. **Docs.** README ×2, configuration ×2, CONTRIBUTING ×2, `csp.ts` comment, code comments that mention the gateway.
9. **Checks and review.** Full local checks; an Opus sub-agent reviews the diff; fix; open the PR.
