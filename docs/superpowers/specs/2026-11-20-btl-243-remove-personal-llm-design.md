# BTL-243: remove the personal LLM API, privacy levels and memory distillation

Addendum to the Butler 4.0 simplification (work item W3). Butler stops talking to any LLM provider of its own. After this change, data leaves the machine only through the user's own `claude`, plus the two outward channels the user switches on themselves: GitHub writes through `gh` (outward actions) and the notification webhook.

## 1. What is removed

| Piece | Where it was | What happens to it |
|---|---|---|
| PrivacyGateway, the OpenAI-compatible provider, the budget, the key status | `src/main/gateway/{gateway,provider,budget,status,types}.ts` | deleted |
| The API key in the system keychain | `src/main/gateway/key-store.ts`, secret `llm_api_key` | `KeyStore` deleted; the migration deletes the stored key |
| Privacy levels, sensitive terms, scan rules, audit of LLM calls | `src/shared/llm.ts`, `db/audit-repo.ts`, `db/terms-repo.ts` | deleted |
| Nightly memory distillation | `MemoryService.distill`, `nightlyDistill`, `DailyDeps.distill`, the `BackgroundRunner` in `index.ts` | deleted |
| Settings `llmLevel`, `llmBaseUrl`, `llmModel`, `llmMonthlyBudgetUsd`, `llmPrices`, `llmConfirm` | `src/shared/settings.ts`, `settings-repo.ts` defaults, `settings-values.ts` | deleted; the migration deletes stored values |
| IPC `llm:status`, `llm:keySave`, `llm:keyClear`, `terms:list`, `terms:save`, `audit:list` | `src/shared/ipc.ts`, `ipc/register.ts`, `api.ts` | deleted |
| Settings › Advanced › "Privacy and personal API" | `PrivacySettings.tsx`, `privacy-form.ts` | deleted (`formatUsd` moves to `format.ts`) |
| Setup wizard step 4 (privacy) | `Wizard.tsx`, `wizard.ts` | deleted; the steps after it move up |
| The "LLM calls" tab of the Audit page | `AuditPage.tsx`, `audit-view.ts` | deleted; the page shows only outward actions |

## 2. What stays, and where it moves

Three things lived in `src/main/gateway/` only because that was the one place allowed to use the network or the keychain. None of them is an LLM call.

| Piece | New place | Why it stays |
|---|---|---|
| The notification webhook sender | `src/main/notify/webhook.ts` | It is the outward action `push_notification`, off by default and audited. |
| The shared MCP's HTTP listener | `memory-mcp/loopback-http.ts` | It only accepts requests on 127.0.0.1 from the user's own `claude`; it never sends. |
| `SecretBox` and Electron `safeStorage` | `src/main/notify/secret-box.ts` | The webhook address is still stored encrypted. |
| `statecoreEnv()` | `src/main/memory/statecore-env.ts` | StateCore must still never see a model key, so it can never call a provider by itself. The bundle tests that prove this stay. |
| The loopback recorder used by tests | `src/main/testing/loopback-recorder.ts` | Test-only. The bundle and notifier tests use it to prove nothing is sent. |

`auditRetentionDays` stays. It has always also set how long outward-action records are kept (`ExternalActions`, the notifier and the startup prune all use it). It moves from the privacy group to the "Outward actions" group in Settings › Advanced, and its control moves into `ExternalActionSettings`. The cutoff becomes plain `now − days`: the old "never before the first of this month" floor existed only to keep this month's LLM spend for the budget. With the default 90 days the floor never applied anyway.

## 3. Network lint

The directory exception for `src/main/gateway/**` is gone. Every source file gets the egress rules. Instead of a directory, three files get exactly the one thing they need, and the lint test proves each of them still rejects everything else:

- `src/main/notify/webhook.ts`: `net` from `electron` and the global `fetch` (the unit-test fallback). No `node:http`, no other Electron network object.
- `memory-mcp/loopback-http.ts`: only `createServer` (and the `IncomingMessage` / `ServerResponse` types) from `node:http`. No `request`, no `fetch`.
- `src/main/testing/loopback-recorder.ts` (test-only): `createServer` and `request` from `node:http`. Lint stops any non-test file from importing or re-exporting anything under `src/main/testing/`, or any path ending in `loopback-recorder`, so the recorder can't be passed on to production code through a sibling re-export or a `./`-style path.

`e2e/fake-claude/fake-claude.cjs` keeps its existing `node:http` allowance. The StateCore import restriction is unchanged.

## 4. `remember(consolidate: true)` without distillation

What StateCore does (checked with the embedded backend, `backgroundDigest: false`): a consolidate call stores the text verbatim as a memory event. Nothing distils it any more, so it stays an event. `recall` returns events next to facts: up to 20 of the most recent ones, or the most relevant with a query, each in full, within the character budget. A 1,900-character entry came back whole beside 30 notes with the default 4,000-character budget.

Decision: **keep consolidate as an event**, and say so.

- Not a note. Notes are capped at 500 characters and 30 per scope; splitting a long entry into notes would push out the decisions and constraints that notes are for.
- Both ways `claude` reaches memory now use Butler's own memory server: the shared MCP hub already did, and the stdio server (the default, `sharedMcp` is off) now does too. `memory-mcp/entry.ts` used to load the statecore-mcp bin, whose tool text promises background distillation. It now runs `MemoryServer` over stdio on the embedded backend with `backgroundDigest: false`, the same as the hub.
- Text changes (English, as Claude Code shows it; the hub and stdio say the same). They are the `BUTLER_OVERRIDES` list in `memory-mcp/memory-tools.ts`:
  - server instructions: "pass consolidate: true for longer conversational context — it is kept word for word and `recall` returns it among recent events";
  - `remember`: "…accepted up to 2000 characters and kept word for word as an event, not a fact; recall returns recent events";
  - `remember.consolidate`: "kept word for word as an event that recall returns among recent events" instead of "distilled into facts in the background";
  - `recall`: no longer mentions a distilled digest; it lists "recent events (including longer context stored with consolidate=true)";
  - `facts`: no longer mentions events waiting for distillation, and its result no longer carries `pending`.
- The stdio line reader moves from `sessions-server.ts` to `memory-mcp/stdio.ts`, so the memory bundle doesn't pull in the butler-sessions code.
- `remember(consolidate: true)` answers `{ ok: true, mode: "event" }` instead of `distillation: "deferred", reason: "background digest disabled"`.
- The contract test still compares Butler's copy of statecore-mcp 1.1.0's tool layer with the real one, word for word. Butler's changes are applied on top as a short, named list of overrides, and the test checks exactly those differences. A statecore-mcp upgrade still fails the test.

Older events that were waiting for distillation when the user upgrades simply stay as events and keep showing up in `recall`.

## 5. Migration

One new migration at the end, append-only:

```sql
DELETE FROM secrets WHERE name = 'llm_api_key';
DELETE FROM settings WHERE key IN ('llmLevel','llmBaseUrl','llmModel','llmMonthlyBudgetUsd','llmPrices','llmConfirm');
DELETE FROM sensitive_terms;
DELETE FROM llm_audit;
```

The tables `llm_audit`, `sensitive_terms` and `secrets` stay (`secrets` still holds the webhook address). The rows are deleted, not left behind: `llm_audit` holds the bodies that were sent and `sensitive_terms` holds people's names, and with no page left to see or clear them, keeping them would be data the user can no longer reach. Config export and import (`src/main/config-io/`) never carried app settings, so an export from an older version has nothing to clean up.

## 6. Docs

- README (both languages): "Local-first", "Where your data lives", "Privacy model" and "Privacy policy" are rewritten. The only ways data leaves the machine are the user's own `claude`, `gh` writes the user switched on, and the webhook the user set up.
- `docs/configuration` (both): the "Privacy and personal API" section is deleted; audit retention is described under "Outward actions"; the memory section says consolidate entries stay as events.
- CONTRIBUTING (both): the gateway rule becomes "no network code, except the three files above".

## 7. Not done here

- The settings page tidy-up and automation levels (W4, W7).
- Dropping the old tables. They stay unused, per the append-only rule.
