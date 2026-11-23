# BTL-246: hierarchy A′ (epic → feature → ticket) and Jira import by epic

Addendum to the Shipherd 4 simplification work. This change flattens the hierarchy, removes two kinds of coordinator, and makes Jira import follow the new shape.

## 1. The new hierarchy

| UI word | What it is | Has a coordinator? | Workspace? | Memory |
|---|---|---|---|---|
| **Global control** (「全局总控」) | The one Shipherd-wide coordinator (was "Shipherd control") | itself | `~/.shipherd/workspaces/_shipherd` | `shipherd-workspace` |
| **Epic** | One body of work: one coordinator, one workspace, one shared memory. Was "feature". One Jira epic maps to one Shipherd epic. | yes, the epic coordinator | yes | `feature:<id>` scope |
| **Feature** | A light block inside an epic: a name, an optional description, a position, and a set of tickets. Blocks are usually pushed forward one at a time, in order. | no | no | none of its own |
| **Ticket** | Unchanged | no (the ticket coordinator is removed) | worktree(s) | `ticket:<key>` scope |

What is removed:

- The old **epic** layer: the epic page, the "new epic" dialog, the epic session, the epic's memory server (`shipherd-epic`), the epic history and digest, the epic summary tab, and the MCP tools `list_features` (the old one), `create_feature` (the old one), `start_feature`, `set_epic_plan` and `epic_context`. The sidebar's epic group and the feature page's "move to epic" picker go too.
- The **ticket coordinator**: the "+ coordinator" button on the ticket's terminal tab, `OpenSessionRequest.coordinator`, the ticket-coordinator MCP tool set and its request handler, and the `ticket_coordinator` and `epic` inbox roles.

## 2. Internal names stay

Internally the epic is still the `features` table, its memory is still the `feature:<id>` StateCore scope, and its MCP servers are still `shipherd-feature` and `shipherd-sessions` with `SHIPHERD_FEATURE=<id>`. The new block is a new `blocks` table, and a ticket points at it with `tickets.block_id`.

Why the internal names are not renamed:

- **The StateCore scopes live in StateCore's own database.** Renaming `feature:<id>` to `epic:<id>` would mean copying every scope's notes, handoff versions and why-chains with no public API for it. A rename would also collide with the old epic's `epic:<id>` scopes, which still exist on disk.
- **The MCP server names are in the users' approval settings.** Shipherd writes `enabledMcpjsonServers`-style approvals per server name. A renamed server would trigger a fresh approval prompt in every open session after the upgrade.
- **Migrations are append-only.** Renaming the tables would touch every query in the repo layer, and the gain would be zero: no user ever sees a table name.

Everything Claude or the user reads uses the new words: UI strings, docs, session guides, MCP tool names and descriptions, and prompts. Internal identifiers keep the old ones. A comment at the top of `features-repo.ts` and `blocks-repo.ts` says which is which.

The epic coordinator's block tools are called `list_features`, `create_feature`, `reorder_features` and `set_ticket_feature`, because Claude should use the same word the user does. The old epic-level tools of the same names are deleted in the same change, so nothing is ambiguous.

## 3. Data model and migration

One new migration, appended at the end:

```sql
CREATE TABLE blocks (
  id INTEGER PRIMARY KEY,
  feature_id INTEGER NOT NULL REFERENCES features(id),
  name TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (feature_id, name)
);
ALTER TABLE tickets ADD COLUMN block_id INTEGER REFERENCES blocks(id);
ALTER TABLE features ADD COLUMN jira_epic_key TEXT;
CREATE UNIQUE INDEX idx_features_jira_epic ON features (jira_epic_key) WHERE jira_epic_key IS NOT NULL AND archived_at IS NULL;
CREATE TABLE epic_memory_archive (...);        -- see §5
-- old epics: each feature is already its own workspace, so it simply becomes an independent epic
UPDATE features SET brief = <brief + old epic's plan> WHERE epic_id IN (SELECT id FROM epics WHERE plan IS NOT NULL);
UPDATE epics SET archived_at = <now> WHERE archived_at IS NULL;
UPDATE sessions SET dismissed = 1, dismissed_at = <now> WHERE dismissed = 0 AND (epic_id IS NOT NULL OR (coordinator = 1 AND ticket_key IS NOT NULL));
UPDATE inbox_items SET status = 'dismissed' WHERE kind = 'report' AND status = 'pending' AND <from an old epic, or from one of the sessions above>;
UPDATE sessions SET coordinator = 0 WHERE ticket_key IS NOT NULL AND coordinator = 1;
```

What the migration does:

- **The old epic's features become independent epics.** Each one already has its own workspace, coordinator and memory, so nothing moves on disk. `features.epic_id` stays as history, and only the one-time memory move in the next point reads it.
- **The old epic's plan** (`epics.plan`, written by `set_epic_plan`) is appended to each of its features' `brief`. The brief is rendered into the epic's memory handoff under "Plan" (§5), so the new epic coordinator sees it on every recall.
- **The old epic's memory.** At the first start after the upgrade, MemoryService copies the Claude-written notes of every old `epic:<id>` scope into `epic_memory_archive` for each of that epic's features. The source is recorded as `epic:<id>`, which makes the copy idempotent. The notes then appear under "Earlier conventions" in each new epic's handoff. The old `epic:<id>` scope itself is left alone, and nothing is deleted.
- **Old epic rows** are archived. Their workspaces on disk are not touched. The tables `epics`, `epic_repos` and `epic_history` stay because migrations are append-only, but no code reads them any more.
- **Old epic sessions and ticket-coordinator sessions** are marked dismissed, so they show up under "hidden sessions" as history. If the user reopens an old ticket coordinator from there, it resumes as a normal ticket session with the ticket-session tool set, because the coordinator tool set no longer exists. The migration clears their `coordinator` flag, so from then on no ticket session is a coordinator and no code path has to tell the two apart.
- **Pending inbox reports** are dismissed so that nothing keeps waiting for a coordinator that can no longer exist. This covers reports from the removed sessions, and reports from a feature coordinator in an old epic, which were addressed to the epic session.
  - The rule uses the reporting session. `inbox_items.epic_id` is no good as a test, because a ticket session's report inside an old epic carries it too. Those reports still have to reach the feature coordinator, which is now the epic coordinator.
  - Pending questions from old epic sessions are dismissed as well. No terminal can take the answer any more.
  - A ticket coordinator's questions stay. It resumes as an ordinary ticket session.

## 4. Blocks (features inside an epic)

- Block names are unique within an epic. The position decides the order, and new blocks go last unless `before` names another block.
- A ticket belongs to at most one block, or to none. Archiving a ticket keeps its `block_id`.
- **Epic coordinator tools** (in `FEATURE_TOOLS`):
  - `list_features`: lists the blocks in order, with each block's tickets and their status.
  - `create_feature { name, description?, before? }`: creates a block.
  - `reorder_features { order: [name|id…] }`: reorders the blocks. The list must name every block exactly once.
  - `set_ticket_feature { ticket, feature | null }`: moves an existing ticket into a block, or out of all of them. Jira-imported tickets need this.
  - `create_ticket` gets an optional `feature` (a block name or id).
  - `list_tickets` shows each ticket's block.
- **The epic page** (the old feature page) shows progress block by block on its overview tab. There is one collapsible row per block, in order, with merged/total. Expanding a row shows its tickets with the same columns as the ticket table. Tickets with no block go in a last row, "Not in a feature".
  - The tab ids are unchanged. BTL-244 renames the label of the `summary` tab to "Status" and keeps the id.
- **The coordinator's guide:**
  - Push the features forward in order, one at a time. Features that do not depend on each other may run at the same time.
  - Put cross-ticket conventions in epic memory (`shipherd-feature`). Ticket progress belongs in ticket memory, and the ticket sessions write it.

## 5. Epic memory, about 60 notes

StateCore 1.1.0 caps notes at 30 per scope. The cap comes from a facet pack that StateCore resolves on every `remember`, for the whole process and not per scope. `overrideFacetCaps` is internal and global, there is no public API to set a per-scope cap, and no newer statecore-mcp release adds one.

Other approaches were considered and ruled out:

- A second StateCore data directory just for epics would mean migrating scopes.
- Writing to StateCore's tables directly would bypass its audit chain.
- A composite backend that spreads one scope over two scopes would be visible to Claude as two memories.

So Shipherd gets the extra room itself, in two parts:

1. **Shipherd stops using note slots in the epic scope.** The decisions from the epic summary used to be written as Shipherd notes, and they shared the 30 slots with Claude. They now go into the Shipherd-rendered handoff of that scope instead, under "Conventions". Old Shipherd decision notes in the scope are forgotten on the next sync, which frees all 30 note slots for the coordinator and the ticket sessions.
2. **Overflow archive.** When a Claude-written note is about to be pushed out, Shipherd moves it to the archive first.
   - **When it runs:**
     - after every Stop of a session in the epic (the coordinator, a ticket session or a fix session);
     - during the start-up sync.
   - **What it does:** when the scope holds `EPIC_ARCHIVE_AT = 26` or more notes, Shipherd moves the oldest Claude-written ones into `epic_memory_archive` until `EPIC_ARCHIVE_KEEP = 20` are left. Each moved note is forgotten in StateCore, which keeps it in StateCore's audit trail.
   - **What happens to the archive:** it keeps the newest `EPIC_ARCHIVE_MAX = 40` entries and logs the ones it drops. It is rendered into the handoff under "Earlier conventions". Each entry carries its date and a line saying that to change one, Claude should remember the new version.
   - That gives 30 live notes plus 30–40 archived, about 60–70 conventions per epic. A burst of more than 4 notes between two Stops can still push out the oldest note, because StateCore evicts before Shipherd sees it. That is the same failure mode as today, only rarer.

The handoff Shipherd writes into an epic scope:

- the summary (as before);
- then "Plan" (the brief), "Conventions" (the decisions from the summary) and "Earlier conventions" (the archive);
- next steps and open questions (as before).

Ticket scopes are unchanged: `SHIPHERD_NOTE_LIMIT` stays 24.

## 6. Global control

- "Shipherd control" becomes **Global control** / 「全局总控」 in the UI and the guide. Internally it stays `shipherd` everywhere.
- `SHIPHERD_TOOLS` changes:
  - `list_epics` lists the epics (the `features` table) with their block progress.
  - `list_features { epic? }` lists the blocks.
  - `list_tickets` shows each ticket's epic and block.
  - `refresh_feature_summary` is renamed `refresh_epic_summary`.
  - `send_message` drops the old epic target, and its target is the epic by name or id. This is coordinated with BTL-245, whose mailbox goes into the same handler.
- The progress overview, the "Now" page and the turn board drop their old-epic rows. Their feature rows are labelled "epic".
- **Report routing.**
  - A ticket session's `done` or `blocked` report goes to its epic coordinator.
  - An epic coordinator's own `done` or `blocked` report is only stored. The global control reads it with `list_inbox`.
  - Typing every epic's report into the one global terminal would interrupt it all day. The global control already patrols the inbox.
- **The message prefixes stay as they are.** For example, 「Shipherd 总控发来的消息」 / "Message from Shipherd control" stays.
  - `conv-parse` and the reply matching recognise sessions' past transcripts by those exact prefixes.
  - Renaming them would make every old conversation unreadable.
  - Only labels the user reads change, such as the sidebar, page titles, settings and role names.
- **User wording.**
  - "feature" in the UI now means a block inside an epic.
  - The old feature is called "epic" everywhere: zh, en, the session guides, the MCP tool descriptions, the handoff templates and the docs.
  - Internal identifiers keep `feature` (§2).

## 7. Jira import by epic

- **The tracker fetch prompt** asks for each ticket's parent epic as `epic: { key, title } | null`. The file source accepts `epic: { key, title }` or a bare key string. `IncomingTicket.epic` is optional, so payloads stored before the upgrade still parse.
- **Grouping:**
  - When a ticket has an epic, intake finds the open Shipherd epic with that `jira_epic_key`. If there is none, it creates one:
    - the name is `<KEY> <title>`;
    - the workspace is the default one;
    - the ticket's repo is added as one of the epic's repos.
  - If that epic was archived, a new one is created, because the user put the old one away on purpose.
  - Tickets without an epic stay standalone, exactly as today.
- **Manual mode** (the repo's intake policy has `autoStart` off, which W7 will call automation level "manual"):
  - Tickets with an epic are created in Shipherd inside their epic, so they are pulled in and organized, but no session is started.
  - The intake row stays held (`auto_off`) as before, so the user can still start it from the queue, and the existing "ticket already exists" path in `openFor` reuses it.
  - Standalone tickets behave as today.
- **Semi mode** (`autoStart` on):
  - Tickets start as today, inside their epic.
  - After a poll that brought new tickets into an epic, Shipherd hands that epic's coordinator one message listing them and asking it to organize them into features and push them forward. If the coordinator is not running, Shipherd opens it first, with the same memory check as any coordinator open.
  - The message goes through the coordinator's mailbox (BTL-245), so it is never refused because the coordinator is busy: a working coordinator gets it at its next tool call, a stopped one has it typed in.
  - If memory is short and the epic has an earlier coordinator, the message stays queued in that coordinator's mailbox and is typed in the next time it opens. If the epic never had a coordinator, the message is skipped and logged, and the next poll that adds tickets tries again.
  - The global control's `send_message` works the same way: it only targets epic coordinators and goes through the mailbox. The old epic layer's `start_feature` and its delivery-guard path are gone.
  - Only tickets that are going to start are listed (queued, waiting or started). Tickets held for size, risk or pre-review are not created yet, so they are left out.
  - A ticket that starts on its own is only created in Shipherd when its session starts, so a queued or waiting one may not exist yet when the message goes out. The list marks those as queued, and the coordinator is told to group them once they show up in `list_tickets`.
- **Not organized:** stacked layers split from a large ticket are created when their layer starts, inside the parent's epic, because they need their start point. A ticket the user later skips in the queue stays in its epic; it can be archived like any other ticket.

## 8. Not in this change

- The automation-level setting itself is W7 (BTL-247). This change maps "manual" and "semi" onto the existing `autoStart` policy.
- There is no UI to create, rename or reorder blocks by hand. The epic coordinator does it through the tools above, and the page shows the result.
- The old `epic:<id>` StateCore scopes are left on disk. They are only read once, for the copy.
