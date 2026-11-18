# Workstream C: lessons foundation (design addendum)

Date: 2026-11-17. Master design: `2026-11-17-butler-3-design.md` (contracts 4.2, 4.3, 4.4). Base: `main` at 2.1.0.

Scope: the data model for lessons admission and scoring, bulk actions with undoable batches, the layered (global → product → repo) resolver and the admission policies built on it, and the export / import framework with the `products`, `lessons` and `policies` sections. This is stage 0 ("foundation") of the lessons plan. Nothing here calls a model.

## 1. What was verified in the code

- `LessonAction` (`src/shared/lessons.ts`) only takes single ids. `LessonsService.dispatch` changes one row per call with `setStatus`, and `merge` deletes the dropped lesson. There is no undo.
- The lessons tables are in the migration that creates `lesson_repos … lesson_queue`. `lessons.status` has a CHECK of `pending | confirmed | disabled | rejected`; changing it would need a table rebuild, so the new states live in new columns instead.
- `lesson_product_repos.repo_slug` and `lessons.repo_slug` reference `lesson_repos(slug)`, and `lesson_repos.local_path` is NOT NULL. An imported repo with no clone on this machine therefore needs a `lesson_repos` row; it gets an empty `local_path` (section 6.6).
- Worktree path → slug already exists: `RepoIdentity.slugOf` (`lessons/repo-identity.ts`, origin remote, cached). The layered resolver reuses it.
- `withTransaction` is re-entrant (savepoints), so a bulk action can wrap other repository calls.
- File dialogs go through `dialog.showOpenDialog` in `ipc/register.ts`; e2e can replace `dialog` methods in the main process with `electronApp.evaluate`.
- Repositories outside lessons that read lessons: `select.ts` (session guide), `lesson-runner.ts` (existing rules for the analysis prompt), `analyze.ts` (`same_as` hits). These have to ignore merged rows.

## 2. Data model (one appended migration)

`lessons` gets these columns; every one has a default that leaves existing rows behaving as in 2.1.0:

| Column | Type / values | Default | Meaning |
|---|---|---|---|
| `scope_globs` | JSON array of path globs | `'[]'` | where the lesson applies; empty = everywhere in its repo / product |
| `scope_lang` | text | null | language, e.g. `ts`, `py` |
| `scope_layer` | text | null | layer, e.g. `renderer`, `api`, `tests` |
| `strength` | `must` / `should` | null | |
| `checkability` | `checkable` / `prose` / `converted` / `covered` | null | null = not classified yet (D backfills) |
| `admission` | `pending` / `auto` / `manual` / `shelved` | `'pending'` | how the admission pipeline judged it |
| `shelved_reason` | text | null | `conflict`, `generality`, `low_score`, `clarity`, `backtest_fp`, `covered`, `duplicate`, … |
| `shelved_ref` | integer | null | the other lesson in a conflict |
| `batch_id` | → `admission_batches.id` (SET NULL) | null | last batch that changed it |
| `merged_into` | → `lessons.id` (SET NULL) | null | merged rows are kept, not deleted |
| `score` | real | null | composite score |
| `score_parts` | JSON | null | `{ evidence, clarity, consistency, verifiability, performance: { value, reason } }` |
| `scored_at` | integer | null | |
| `score_policy_version` | integer | null | which policy version produced the score |
| `degraded` | 0 / 1 | 0 | produced by a fallback model (router, 4.1) |
| `degraded_from` | text | null | the tier / model it fell back from |

The migration then sets `admission = 'manual'` for every `confirmed`, `disabled` and `rejected` row: those were decided by a person and automatic demotion must never touch them. `pending` rows stay `admission = 'pending'`. `status` values are not changed.

**`status` and `admission` are separate on purpose.** `status` still decides what reaches sessions (`confirmed` only). `admission` records the pipeline's verdict: D's pipeline marks a pending lesson `auto` (recommended) or `shelved` (with a reason) without confirming it. "Accept all recommended" confirms `status = pending AND admission = auto` and leaves `admission = auto`, so later demotion knows it was automatic. A person confirming or rejecting a lesson sets `admission = manual`. If the policy `admission.autoConfirm` is on (default off), D may confirm directly; that is still one batch with `origin = auto`.

New tables:

- `admission_batches`: `id`, `created_at`, `kind` (`confirm`, `reject`, `disable`, `enable`, `delete`, `edit`, `merge`, `accept_recommended`, `import`, `replace`, `admission`, `demote`, `undo`, …; free text so later workstreams add kinds), `origin` (`manual` / `auto` / `import`), `entity` (`lesson`, later `check`), `scope` (JSON: the filter or id list that selected the rows), `policy_snapshot` (JSON, the resolved policy when an automatic batch ran), `summary` (JSON, e.g. per-reason counts), `affected`, `undone_at`, `undo_of` (the batch an `undo` batch reverted).
- `admission_batch_items`: `batch_id`, `entity`, `entity_id`, `before` (JSON row snapshot, null = the row did not exist), `after` (JSON, null = the row was deleted). Primary key (`batch_id`, `entity`, `entity_id`). The master design's "before-state snapshot" is stored per row here rather than as one blob, so undo is per row and E1 can store check rows in the same table.
- `admission_policies`: one row per layer: `scope_kind` (`global` / `product` / `repo`), `product_id` (→ `lesson_products`, CASCADE), `repo_slug`, `values` (JSON object of overridden keys only), `updated_at`. Unique on (`scope_kind`, `COALESCE(product_id, 0)`, `COALESCE(repo_slug, '')`).
- `batch_reviews`: `batch_id` (→ batches, CASCADE), `sample_size`, `pass_rate`, `coverage`, `shelved_shares` (JSON), `backtest_recall`, `backtest_false_positives`, `verdicts` (JSON, per sampled item), `created_at`. Filled by D (sampling) and F (coverage, backtest).
- `score_calibration`: `id`, `lesson_id` (SET NULL), `entity` (`lesson` / later `check`), `auto_verdict`, `human_verdict`, `score`, `score_parts`, `batch_id`, `at`. C records a sample whenever a person overrides an automatic verdict (section 3.4); D's calibration screen reads them.

`checks`, `check_backtests` and `repo_baselines` are **not** created here (E1, F and E2 own them).

## 3. Batches and undo (contract 4.4)

### 3.1 The batch recorder

`src/main/batches/batch-recorder.ts` is entity-agnostic. An entity registers an adapter `{ snapshot(id): object | null; restore(id, before: object | null): void }`. `recorder.run(meta, ids, mutate)` opens one transaction, snapshots every id, runs `mutate`, snapshots again, writes the batch and its items (only rows whose snapshot actually changed count as affected), and returns `{ batchId, affected, skipped }`. A batch with zero affected rows is not written (`batchId: null`).

The `lesson` adapter's snapshot is the full `lessons` row plus its `lesson_sources`. Restore: `before = null` deletes the row; otherwise the row is updated in place, or re-inserted with the same id (and its sources) if it was deleted.

### 3.2 Undo

`undoBatch(id)` restores, in one transaction, each item whose **current** snapshot still equals the batch's `after`; rows changed since by something else are skipped and counted (`skipped`), never overwritten. It writes an `undo` batch (with its own before / after, `undo_of = id`) and sets `undone_at` on the original. Undo batches are shown in history but cannot themselves be undone; a batch already undone cannot be undone twice.

### 3.3 Bulk actions

`LessonBatchService` (`src/main/lessons/lesson-batches.ts`):

- `confirmMany(target)`: `pending` → `confirmed`, `admission` → `manual` (kept `auto` for `acceptRecommended`).
- `rejectMany(target)`: any non-rejected → `rejected`, `admission = manual`.
- `disableMany(target)` / `enableMany(target)`: `confirmed` ↔ `disabled`.
- `deleteMany(target)`: rows removed (undo re-inserts them with their sources).
- `acceptRecommended(target)`: `confirmMany` restricted to `admission = auto`, batch kind `accept_recommended`. The button is on the lessons page now; until D merges nothing is `auto`, so it shows zero and is disabled.
- `undoBatch(id)`.

`target` is `{ ids: number[] }` or `{ filter: LessonFilter }`. `LessonFilter` (`src/shared/lesson-filter.ts`): `slug` (lessons scoped to that repo), `productId`, `status[]`, `admission[]`, `checkability[]` (with `unclassified`), `minHits`, `minScore`, `maxScore`, `batchId`, `text` (substring, case-insensitive), `shelvedReason[]`, `degraded`. The match function is a pure function shared by main and the renderer: the page shows "N match" with exactly the rule main applies. Main resolves the filter inside the transaction, so the count and the change cannot drift. Rows already in the target state are skipped and counted, not errors. Merged rows never match.

The old single-id ops (`confirm`, `reject`, `setDisabled`, `delete`, `edit`, `merge`) keep their shapes and checks (`not_found`, `bad_status`, `same_lesson`, `scope_mismatch`) and run through the same recorder, so every change on the page is undoable. A single `confirm` whose row is not pending still returns `bad_status`.

`merge` now keeps the dropped lesson: its sources are copied to the kept one (as before), hits add up, and the dropped row gets `merged_into = keep` instead of being deleted. Every reader that lists live lessons excludes merged rows (`lessons()` takes `includeMerged`), and `applyAnalysis` follows `merged_into` when the model answers `same_as` with a merged id, so a hit lands on the lesson that survived.

### 3.4 Calibration samples

When a person overrides an automatic verdict, C writes a `score_calibration` row: confirming a `shelved` lesson, rejecting / disabling / deleting an `auto` lesson, and undoing an `origin = auto` batch (one row per restored lesson). The verdicts are `admit` / `shelve` / `reject`.

### 3.5 The page

- The lessons page gets three top-level tabs: **Lessons** (the existing tree and detail), **Batches** (history) and **Import / export**.
- Under Lessons, a **filter bar** (repo / product = the left-hand selection or "all", status, admission, checkability, shelved reason, min hits, score range, batch id, text, only output of a fallback model) shows how many lessons match and offers "Confirm all N", "Reject all N", "Disable all N" (and "Enable all N" when the filter matches disabled ones). Delete always takes two clicks (arm, then confirm), like the existing delete; with no filter and "all" selected, every bulk button takes two clicks. The counts on the buttons are computed in the renderer with the same rules the main process uses (confirm only touches pending, disable only confirmed, enable only disabled, reject anything not already rejected), so "Confirm all 12" changes exactly 12. **Delete all** without a status filter is sent with the three visible statuses, so it never deletes rejected lessons, which the page does not show and the count does not include.
- "Accept all recommended (M)" sits at the top of the Lessons tab.
- Pending and confirmed lessons get checkboxes; with any checked, "Confirm selected / Reject selected" (pending) and "Disable selected / Reject selected" (confirmed) act on the id list as one batch. Merging still needs exactly two confirmed ones checked.
- After any bulk action a notice says what happened ("Confirmed 412 · 3 skipped") with an **Undo** button for that batch.
- Lessons show tags when the new fields are set: admission (`auto` = recommended, `shelved` + reason), checkability, strength, score, "degraded".
- **Batches** lists batches newest first: time, what was done, by whom (`manual` / `auto` / `import`), how many rows, whether undone; expanding one shows each lesson's text with its before → after status; "Undo this batch" with a two-click confirm.

## 4. Layered scopes (contract 4.2)

`src/main/scope/layered.ts`:

```ts
type ScopeRef = { kind: "global" } | { kind: "product"; productId: number } | { kind: "repo"; slug: string };
mergeLayers(defaults, layers) → { value, origin }   // origin: per key, the ScopeRef that set it, or "default"
class LayeredResolver<T> {
  constructor({ defaults, read(ref) → Partial<T> | null, productsOf(slug) → ProductView[], slugOf?(path) })
  forGlobal(); forProduct(id); forRepo(slug); forPath(path)   // forPath uses RepoIdentity
}
```

- Order: defaults → global → each product the repo belongs to → repo. Later layers override earlier ones **key by key**; nested plain objects are merged key by key too; arrays and scalars are replaced whole. `undefined` means "not set here" (inherit).
- A repo in several products: products apply in ascending name order, so the last name wins; the `origin` map shows which product set each key, and the policy editor warns when two products of the same repo set the same key differently.
- The resolver is generic; E1 (checks), G (readiness), L (cost caps) and J (permission profiles) give it their own `read`.

### 4.1 Admission policies

`src/shared/admission-policy.ts` lists every policy key from the plan's "admission policy settings" with its type, bounds and default (master design section 6). Keys are flat and dotted so each one can be overridden on its own:

| Group | Keys (default) |
|---|---|
| Scoring | `score.weight.evidence` (0.3), `score.weight.clarity` (0.2), `score.weight.consistency` (0.2), `score.weight.verifiability` (0.3), `score.weight.performance` (0), `score.admitLine` (0.7), `score.dropLine` (0.3), `score.proseAdmitLine` (0.8), `score.untestedCap` (0.69), `score.reviewerBonus` (0.05), `score.recencyHalfLifeDays` (180), `score.degradedPenalty` (0.1) |
| Batch floors | `batch.sampleSize` (20), `batch.minSamplePassRate` (0.8), `batch.minCoverage` (0.3), `batch.maxShelvedShare` (0.7), `batch.minBacktestRecall` (0.01), `batch.maxBacktestFalsePositiveRate` (0.2) |
| Generality | `generality.minHits` (2), `generality.minPrs` (2), `generality.minReviewers` (0) |
| Backtest | `backtest.recentPrs` (50), `backtest.minRecall` (0.01, "recall > 0"), `backtest.maxFalsePositiveRate` (0.2), `backtest.allowUntestedShadow` (true) |
| Shadow mode | `shadow.minPrs` (5), `shadow.minDays` (7), `shadow.maxFalsePositiveRate` (0.2), `shadow.minAdoption` (0.6), `shadow.autoPromote` (false) |
| Conflicts | `conflict.autoPickHigherHits` (false) |
| Demotion | `demote.enabled` (true), `demote.maxBypassRate` (0.3), `demote.noReductionPrs` (10), `demote.to` (`shadow` / `review`, default `shadow`) |
| Admission | `admission.autoConfirm` (false) |

`shadow.autoPromote` and `admission.autoConfirm` default off (anti-goal: no silent behaviour change). Defaults are shown as "uncalibrated defaults" until a calibration exists. Every change bumps a policy version (setting `admissionPolicyVersion`, not user-editable) which D writes into `score_policy_version`.

`AdmissionPolicyService` stores layers in `admission_policies`, validates every value against the key table (unknown keys and out-of-range values are rejected), and resolves through `LayeredResolver`.

**Settings → Admission policy**: pick a layer (Global, any product, any repo); every key shows the effective value, where it comes from (default / global / product name / this layer) and an input to override it here, plus "Inherit" to clear the override.

## 5. Export / import (contract 4.3)

`src/main/config-io/`:

- `format.ts`: the file is one JSON object: `{ format: "butler-config", formatVersion, exportedAt, butlerVersion, scope, options, sections }`. `CURRENT_FORMAT_VERSION = 1`. A file with a higher version is refused ("made by a newer Butler, upgrade first"); a lower one runs the registered migration functions in order (`migrateDoc`). A file that is not JSON, not `butler-config`, or fails a section's schema is refused with the section named.
- `registry.ts`: `ConfigSection<Item>` = `{ id, order, schema, export(scope, options), preview(incoming, ctx) → SectionPreview, apply(incoming, plan, ctx) → counts }`. Sections register at startup; the file lists whatever sections were exported, and import skips (and reports) sections this Butler does not know.
- `fingerprint.ts`: sha256 of a canonical JSON of the item's identity fields, first 16 hex characters. Lessons: normalised text (trim, collapse spaces, lower case) + scope (repo slug or product name) + sorted globs. Products: name. Policies: the layer (global / product name / repo slug). Fingerprints never use local ids.
- `service.ts`: `exportDoc(scope, options)`, `writeExport(file, …)`, `preview(file)` (parse → migrate → each section's preview; keeps the parsed document under a token), `apply(token, mode, resolutions)`.

### 5.1 Preview

Per section and in total: **added** (fingerprint not here), **changed** (same fingerprint, content differs), **conflicting** (same fingerprint and a *decision* differs: a lesson's status or strength or checkability, a product's repo list, a policy key set to different values on both sides; plus, for lessons, semantic conflicts reported by D's detector), **unchanged**, and for replace mode **removed** (local items in the export's scope that the file does not have). Each changed / conflicting row shows local vs incoming.

**Hook for D**: `setLessonConflictDetector(fn)` where `fn(incoming, local) → Promise<{ fingerprint, localId, reason }[]>`. When set, its results are added to `conflicting`. C ships without one (fingerprint-level only).

### 5.2 Apply

- Mode **merge**: added items are created; for changed / conflicting items the resolution chosen per row, or in bulk ("All imported" / "All local"), decides; the default is local. Local items absent from the file are kept.
- Mode **replace**: first writes an automatic backup export of everything (to `<BUTLER_HOME>/backups/before-replace-<time>.json`; if the backup fails, nothing is imported), then applies as merge with "imported" as the default resolution, then removes the local items in the file's scope that the file does not have.
- **Imported lessons enter pending**: new lessons get `status = pending`, `admission = pending`; a lesson the file marks `rejected` arrives `rejected` (a rejection never makes anything reach a session). An existing lesson's status is only changed when the person picks "imported" on a conflict. Hits become the larger of the two.
- Every apply is **one batch** (`kind = import` or `replace`, `origin = import`) covering lessons; Batches can undo it. Products and policies are written in the same transaction; products and policies created by an import are recorded as entities `product` / `policy` in the same batch so undo removes them too.
- Repos named in the file that this machine does not know get a `lesson_repos` row with an empty local path ("not cloned here"). Analysis, backfill and "open in Claude" refuse such repos (`unknown_repo` / `not_found`), and the page shows "not cloned on this machine". When Butler later finds a clone with that slug, the path is filled in as usual.

### 5.3 What an export contains

- Scope: **everything**, **one product** (the product, its repos' slugs, the product's lessons and its repos' lessons, the policies of the product and its repos), or **one repo** (its lessons and policy layer). Content: **all**, **lessons only** (products + lessons), **checks only** (only sections that declare `content: "checks"`; disabled until E1 registers `checks`). Policies go with "all".
- Never: secrets, local paths (`local_path`, worktree paths), comment text, transcripts, run material. Lessons carry text, `why`, status, admission, scope fields, strength, checkability, hits, number of sources and of distinct PRs, first / last seen. **Source URLs** (with PR numbers) only when "Include source URLs" is ticked (default off).
- Scores are not exported (they depend on this machine's history and policy version).

### 5.4 Starter packs

"Export as starter pack" on a product or repo writes a file with `scope.kind = "starter"`, a name, and lessons with no repo / product binding, no status, no hits and no sources. Importing one asks for a target repo or product; every lesson arrives pending under one import batch. Fingerprints are computed after binding to the target, so importing the same pack twice adds nothing.

### 5.5 Automatic backups and reminders

- `configBackupIntervalDays` (default `0` = off): when set, the scheduler tick writes a full export to `<BUTLER_HOME>/backups/auto-<time>.json` once per interval (job `config_backup`) and keeps the newest `configBackupKeep` (default `10`) automatic backups. Backups go to Butler's own folder; they never contain secrets or local paths.
- `configExportReminderDays` (default `30`, `0` = off): the Import / export tab, and a line on the Lessons tab, remind the user when there are confirmed lessons and neither a manual export nor a backup has happened in that many days.
- "Back up now" and "Open backups folder" on the Import / export tab.

## 6. Other decisions

1. **No model calls.** Nothing in C goes through the router; D adds enrichment, scoring and semantic conflicts.
2. **IPC.** Bulk ops and undo are new `LessonAction` ops (`bulk`, `acceptRecommended`, `undoBatch`), so the existing validated `lessons:act` channel carries them; `LessonActResult` gains optional `batchId`, `affected`, `skipped`. New channels: `lessons:batches`, `lessons:batch`, `policies:get`, `policies:set`, `config:status`, `config:export`, `config:importPreview`, `config:importRetarget` (picks the target of a starter pack and re-runs the preview under the same token), `config:importApply`, `config:backupNow`, `config:openBackups`. Every argument is validated in `ipc/validate.ts`.
3. **Id lists are capped** at 5000 ids per call; a filter has no cap.
4. **Both platforms.** Only Node / Electron APIs (`node:crypto`, `node:fs`, `dialog`, `shell.openPath`); file names avoid `:` so they are valid on Windows.
5. **Merged rows** are invisible everywhere except Batches history and the export of a batch's items.
6. **Repos with an empty local path** are treated as "not cloned here" (5.2).
7. **File dialogs stay in the main process.** `config-io/facade.ts` opens the save / open dialogs and passes only the chosen path to `ConfigIoService`; the renderer never sends a file path, so a compromised page cannot make Butler read or write an arbitrary file. A cancelled dialog returns `{ ok: false, reason: "cancelled" }` and shows nothing. The e2e tests replace `dialog.showSaveDialog` / `showOpenDialog` through `electronApp.evaluate`, so no system window opens and focus is never taken.
8. **Two-phase apply.** Preview parses, migrates and validates the file once and keeps the result under a random token; apply takes the token and the choices, never the file again, so what is applied is exactly what was previewed. A token is dropped after apply, after six hours unused (each use, such as picking a starter target, restarts the clock; resolving rows one by one can take a while), or when more than five previews are open (oldest first). The renderer mirrors the main process's per-row default (added and removed rows follow the file; otherwise the bulk choice; otherwise imported for replace, local for merge) to show what each row will do before Apply.
9. **Semantic conflicts.** D's detector runs during preview, after fingerprint matching; its hits turn a row into `conflicting` with the reason and the related local lesson. If the detector throws, the preview still succeeds without its rows and logs the error.
10. **Reminder baseline.** "Days since export" counts from the later of the last manual export and the last automatic backup; before either has happened it counts from the oldest confirmed lesson, so a fresh install with nothing confirmed never reminds.
11. **Backup kinds.** Files in `<BUTLER_HOME>/backups/` are named by kind: `auto-` (scheduled; only these are pruned to `configBackupKeep`), `before-replace-` (written before a replace import; never pruned automatically) and `manual-` ("Back up now"; never pruned).
12. **Docs.** `docs/configuration.md` and its Chinese twin get the three new settings, the admission policy keys, and the export file format.

## 7. Acceptance

- Existing pending lessons can be confirmed or rejected in one action by filter, and the whole batch undone (unit + integration tests, and an e2e test on the page).
- A file exported from one `BUTLER_HOME` imports into another and the preview shows added / changed / conflicting (integration test with two databases, and an e2e test with two sandboxes and stubbed file dialogs).
- 2.1.0 data migrates with statuses unchanged and `admission = manual` on decided rows.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` pass on macOS and Windows.
