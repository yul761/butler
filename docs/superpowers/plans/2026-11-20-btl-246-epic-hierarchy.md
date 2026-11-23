# BTL-246 plan: hierarchy A′ and Jira import by epic

Spec: [2026-11-20-btl-246-epic-hierarchy-design.md](../specs/2026-11-20-btl-246-epic-hierarchy-design.md).

This is one PR. Each step is its own commit, and the tree compiles with tests green after every step. Tests come first in each step, before the code that makes them pass.

## Why it is not a stack

The removal (steps 2–3) touches nearly every file that the later steps also touch:

- session-service
- sessions-server
- control-handler
- strings
- the feature page

If it were split into layers, each upper layer would rebase on top of a ~150-file deletion while BTL-244 and BTL-245 land on `main`. That is a lot of conflict resolution and no smaller review, because the reviewer would still need all the layers to judge the hierarchy. Ordered commits give the same reading order.

## Steps

1. **Schema.**
   - Write the migration from spec §3.
   - Add `BlocksRepo` with insert, list (ordered), get, byName, reorder, setTicket and ticketsOf.
   - Add `FeaturesRepo.byJiraEpic` and `setJiraEpic`.
   - Add `EpicArchiveRepo` with add, list, has(source) and trim(max).
   - Tests:
     - migration tests (old epic plan → brief, sessions dismissed, inbox dismissed, epics archived);
     - repo tests.
2. **Remove the ticket coordinator.**
   - Remove:
     - the button and the restore path in `TicketTerminalTab`;
     - `OpenSessionRequest.coordinator`;
     - the placement coordinator branch, `addDirsFor` and `writeTicketMcpConfig(coordinator)`;
     - `TOOLS` / `ticketRequest`;
     - the coordinator ops in `TicketControlRequest`;
     - the `ticket_coordinator` role and its report target.
   - Every ticket session now gets the member scope.
   - Update the e2e `multi-repo.spec` and `hibernate.spec` to use a plain ticket session or a feature coordinator.
3. **Remove the old epic layer.**
   - Delete `src/main/epics/`, `epics-repo` and `epic-history-repo`, and their code paths in session-service, session-refresher, refresh-tail, memory-service, mcp-config, inbox, now, turn, progress, prwatch, stacks, gate/who, daily-jobs, metrics, conv-parse, ipc, validate, api, App, Sidebar, AllWorkPage, ArchivedPage, FeaturePage, FirstRunHome, home-view, sidebar-view, scope-view, route-view and the strings.
   - Delete `EPIC_TOOLS`, `EPIC_CONTEXT_TOOL`, `epicRequest`, `SHIPHERD_EPIC` and `SHIPHERD_FEATURE_EPIC`.
   - Delete `e2e/epics.spec.ts` and move what still applies (archiving a feature, the stuck mark) to `features.spec`.
   - Keep the `epic_id` columns. Remove the `model-routing` task `epic_digest`, and load stored settings that still name it without error.
4. **Blocks.**
   - Add the control ops `list_features`, `create_feature`, `reorder_features` and `set_ticket_feature`, plus the `create_ticket` `feature` argument and the `list_tickets` block field.
   - Add the matching tools in `FEATURE_TOOLS` and `FEATURE_TOOLS_EN`.
   - Add `FeatureView.blocks`, with the blocks and their ticket keys.
   - The epic page overview groups tickets by block (`ScopeBlocks`).
   - Update the guide text (in order, independent blocks in parallel, which memory holds what).
5. **Epic memory.**
   - `syncFeatureNow` renders Plan, Conventions and Earlier conventions into the handoff and stops writing decision notes; existing Shipherd decision notes are forgotten.
   - Add `archiveOverflow(featureId)`, called from `sessionStopped` and from `syncAll`.
   - Add the one-time copy of the old `epic:<id>` notes.
   - Tests in `memory-service.test`.
6. **Global control.**
   - Change the strings.
   - Rework `list_epics` and `list_features`, rename `refresh_epic_summary`, and change the `send_message` target to `epic`.
   - Update the patrol prompt.
7. **Jira.**
   - Add `FetchTicket.epic`, the fetch prompt line, `normalizeIncoming` and `IncomingTicket.epic`.
   - Add the intake deps `ensureEpic` and `setTicketEpic`.
   - Manual mode creates the ticket in its epic and does not start it; semi mode hands the epic coordinator a message after the poll.
   - Tests in `intake-service.test` and `sources.test`.
8. **Wording.**
   - Rename feature → epic across the UI strings (zh and en), the main strings, the guides, the tool descriptions, the README pair and the configuration pair.
   - Label the global control.
9. **Checks.**
   - Run typecheck, lint, test and e2e.
   - Get an Opus review.
   - Rebase on `main` (BTL-244 and BTL-245 merge first) and open the PR.
