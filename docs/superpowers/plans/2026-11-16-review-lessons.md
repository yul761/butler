# review 经验 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 从已合并 PR 的 review 里提炼"开发时本来能避免"的规矩，经用户确认后，自动写进 Shipherd 打开的 ticket session 和修复 session 的说明里。左侧菜单新加「review 经验」页，在那里管理仓库、产品和规矩。

**Architecture：**
- **仓库身份：** 仓库用 git remote `origin` 解析出的 slug 认（`owner/name`；不是 github.com 的写成 `host/owner/name`）。
- **队列：** 素材和分析都放在新的持久化队列 `lesson_queue` 里。`LessonRunner` 同时最多跑 2 个，每个 PR 跑一次后台 claude（`execHeadlessJson`），输出结构化 JSON。`applyAnalysis` 根据 JSON 新建待确认的规矩，或者给已有规矩加一次出现。
- **送进 session：** 打开 session 时，按这个 session 涉及的仓库路径挑出已确认的规矩，最多 30 条，写进说明文件。有规矩的说明按内容 hash 单独成文件，没有规矩的照旧共用 `guide-<kind>-<lang>.md`。

**Tech Stack：** Electron + TypeScript，node:sqlite（`db/database.ts`），zod（`handoff/schema.ts`），React 渲染进程，vitest，Playwright e2e。

**Spec：** `docs/superpowers/specs/2026-11-15-pr-stages-and-review-lessons-design.md` 的「第二件：review 经验」。第一件已经在 1.9.0 发布。

## Global Constraints

- **规矩只存在 Shipherd 里**（用户 2026-11-16 定的）。不写进仓库的 `CLAUDE.md`、`.github/copilot-instructions.md`，也不做导出按钮。不给不是 Shipherd 开的 session 送规矩，不做统计和趋势图。
- **没经用户确认的规矩不能送进任何 session。** 只有 `status = 'confirmed'` 的才送。待确认、停用、驳回的都不送。
- **每个 session 最多 30 条规矩**（`MAX_SESSION_LESSONS = 30`），不管涉及几个仓库、几个产品。排序：出现次数降序，再按最后出现时间降序，再按 id 升序。
- **只给 ticket session 和修复 session 送**（`GuideKind === "ticket"`）。ticket 总控、feature 总控、epic、Shipherd 总控都不送。
- **生效时机：** 规矩改了，对已经开着的 session 不生效，下一次打开或恢复时才生效。换新（`/clear`）不重新读规矩。
- **界面字符串成对加：** `src/renderer/src/strings.ts`（ZH）和 `strings-en.ts`（EN）；main 进程的字符串加在 `src/main/strings.ts` 的 ZH 和 EN 两边。`strings.test.ts` 会检查两边的键。
- **README 成对更新：** README.md 和 README.zh-CN.md 一起改。
- **新表：** 只在 `src/main/db/migrations.ts` 的 `MIGRATIONS` 末尾追加一条（第 21 条，user_version 21），已发布的条目不能改。
- **gh 调用：**
  - 新的 gh 调用都写在 `tickets/gh.ts` 里，用私有的 `runGh` / `parseLines`，失败返回 null，不抛错。
  - PR 监视的轮询频率不变，`prStatus` 的字段也不改。
  - 渲染进程不调 gh，也不调 git。
- **后台分析的模型和用量：**
  - 后台分析走用户自己的 `claude`（`execHeadlessJson`，deps 从 `judgeDeps` 展开），不传 `--model`，用用户默认的模型，和 handoff 一样。
  - 用量经 `onUsage` 记录，label 是 `lessons`。
  - 不写 `llm_audit`，不受隐私档位影响。
- **网络：** 只经 gh / git / claude 三个 CLI，不在 main 里直接 fetch（`egress-lint.test.ts`）。
- **提交信息最后一行：** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- **每个任务结束前：** 跑 `pnpm -s typecheck && pnpm -s lint && npx vitest run <相关目录>`，全部通过。

## Review Focus

1. **分析给出的"和第 N 条意思一样"指向驳回过的规矩**：直接丢掉，不新建、不复活、不打扰用户。指向不存在的 id 时当作新规矩进待确认，不报错。Task 5 有测试。
2. **超过 30 条已确认的规矩**（ticket 有两个仓库，各自加产品的规矩合计 40 条）：只送前 30 条，顺序按上面的规则；停用的和待确认的一条都不出现。Task 7 有测试。
3. **app 在分析中途退出**：重新打开后，`running` 的行回到 `queued` 重跑。同一个 PR 不会排两次（`UNIQUE(repo_slug, pr_number)`）。`rate_limited` 不算失败，放回队列，10 分钟后再取。Task 6 有测试。
4. **修复 session 被恢复**：现在 `openFeature → resumeOrStart → startInFeature(feature, claude, { head })` 不带 `fixes`，`guideKind` 会变成 `"coordinator"`，规矩就丢了。要改成看 `head.fixesSession`。Task 7 有测试。
5. **没有 GitHub remote、gh 没装或没登录的仓库**：
   - 页面显示原因，「分析历史」按钮不能点。
   - 队列里的 PR 在 gh 失败时标成 `failed` 并记下原因，不会每轮重试。
   - 再点一次「分析历史」，会把 failed 的重新排进去。

   Task 6 和 Task 8 有测试。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/shared/lessons.ts`（新） | 类型：规矩、仓库、产品、页面视图、页面动作；常量 `MAX_SESSION_LESSONS` |
| `src/main/lessons/repo-identity.ts`（新） | `parseRemoteSlug`（纯函数）和 `RepoIdentity`（路径 → slug，同步，有缓存） |
| `src/main/db/lessons-repo.ts`（新） | 新表的读写，包括队列 |
| `src/main/tickets/gh.ts` | 新加 `mergedPrs`、`prLessonData`、`compareFiles` |
| `src/main/lessons/material.ts`（新） | 纯函数：判断 PR 有没有 review 内容，拼素材文本，从对话记录摘段落 |
| `src/main/lessons/analyze.ts`（新） | prompt、zod schema、`applyAnalysis` |
| `src/main/lessons/lesson-runner.ts`（新） | 队列执行：同时最多 2 个、回溯、每日拉取、PR 合并时排队 |
| `src/main/lessons/select.ts`（新） | 纯函数：挑出送进 session 的规矩、算"送不进去"几条、建议归组 |
| `src/main/lessons/lessons-service.ts`（新） | 页面视图和页面动作 |
| `src/main/claude/session-guide.ts` | 新加规矩那一段；有规矩时按 hash 单独成文件；清理旧文件 |
| `src/main/sessions/session-service.ts` | `guidePath` 多传仓库路径；修复 session 恢复时 kind 不变 |
| `src/main/prwatch/pr-watcher.ts` | 新加 `onMerged` 回调 |
| `src/main/db/migrations.ts`、`src/main/index.ts`、`ipc/*`、`shared/ipc.ts`、`renderer/src/api.ts` | 迁移、接线、IPC |
| `src/renderer/src/components/LessonsPage.tsx`（新）、`lessons-view.ts`（新）、`Sidebar.tsx`、`App.tsx`、`styles.css`、strings | 页面 |
| `e2e/fake-claude/fake-claude.cjs`、`e2e/lessons.spec.ts`（新）、README ×2 | 端到端测试和文档 |

---

### Task 1: 共用类型和仓库身份

**Files:**
- Create: `src/shared/lessons.ts`
- Create: `src/main/lessons/repo-identity.ts`
- Test: `src/main/lessons/repo-identity.test.ts`

**Interfaces:**
- Produces（`src/shared/lessons.ts`）：
  ```ts
  export const MAX_SESSION_LESSONS = 30;
  export type LessonStatus = "pending" | "confirmed" | "disabled" | "rejected";
  export type LessonScope = { kind: "repo"; slug: string } | { kind: "product"; productId: number };
  export interface LessonSource { id: number; prNumber: number; url: string | null; at: number }
  export interface Lesson {
    id: number; scope: LessonScope; text: string; /** 为什么提这条，一两句。 */ why: string;
    status: LessonStatus; hits: number; lastSeenAt: number; createdAt: number; sources: LessonSource[];
  }
  export interface LessonRepoView {
    slug: string; localPath: string;
    /** 上次分析完一个 PR 的时间。 */ lastAnalyzedAt: number | null;
    analyzedCount: number; queued: number; failed: number; backfilled: boolean;
    /** 单独开这个仓库的 session 时，有几条已确认的送不进去。 */ overflow: number;
  }
  /** 没有 origin remote 或解析不出 slug 的仓库路径，页面上说明原因。 */
  export interface LessonUnknownRepo { path: string; reason: "no_remote" | "not_git" }
  export interface LessonProductView { id: number; name: string; slugs: string[] }
  export interface LessonProductSuggestion { slugs: string[]; together: number }
  export interface LessonsState {
    repos: LessonRepoView[]; unknownRepos: LessonUnknownRepo[]; products: LessonProductView[];
    suggestions: LessonProductSuggestion[];
    /** 不含 rejected。 */ lessons: Lesson[];
    ghAvailable: boolean;
  }
  export type LessonAction =
    | { op: "confirm"; id: number; text?: string } | { op: "reject"; id: number }
    | { op: "edit"; id: number; text: string } | { op: "setDisabled"; id: number; disabled: boolean }
    | { op: "delete"; id: number } | { op: "merge"; keepId: number; dropId: number; text: string }
    | { op: "createProduct"; name: string; slugs: string[] } | { op: "deleteProduct"; id: number }
    | { op: "addToProduct"; id: number; slug: string } | { op: "removeFromProduct"; id: number; slug: string }
    | { op: "backfill"; slug: string } | { op: "openSource"; sourceId: number };
  /** 送进 session 说明的一行。label 是仓库 slug 或产品名。 */
  export interface SessionLesson { label: string; text: string }
  ```
- Produces（`repo-identity.ts`）：
  ```ts
  export function parseRemoteSlug(url: string): string | null;
  export class RepoIdentity {
    constructor(d: { git: (path: string) => string | null }); // 默认实现：execFileSync("git", ["-C", path, "remote", "get-url", "origin"], { timeout: 3000 })，失败返回 null
    slugOf(path: string): string | null;  // 结果（包括 null）按 path 缓存在内存里，app 运行期间不过期
    /** 页面用：解析不出时说明原因。 */
    resolve(path: string): { slug: string } | { reason: "no_remote" | "not_git" };
  }
  ```

- [ ] **Step 1: 写失败的测试** `repo-identity.test.ts`：
  - `parseRemoteSlug("https://github.com/acme/web.git")` → `"acme/web"`
  - `parseRemoteSlug("git@github.com:acme/web.git")` → `"acme/web"`
  - `parseRemoteSlug("ssh://git@github.com/acme/web")` → `"acme/web"`
  - `parseRemoteSlug("https://ghe.corp.com/team/api.git")` → `"ghe.corp.com/team/api"`
  - `parseRemoteSlug("https://github.com/Acme/Web")` → `"acme/web"`（转小写）
  - `parseRemoteSlug("/local/path/repo.git")` → `null`，`parseRemoteSlug("")` → `null`
  - `RepoIdentity`：注入的 `git` 计数，同一路径调两次 `slugOf` 只调一次 `git`；`git` 返回 null 时，路径是 git 仓库（`makeRepo()`）就返回 `{ reason: "no_remote" }`，`tempDir()` 返回 `{ reason: "not_git" }`。
- [ ] **Step 2:** 跑 `npx vitest run src/main/lessons/repo-identity.test.ts`，预期 FAIL（模块不存在）。
- [ ] **Step 3: 实现。** `resolve` 用 `existsSync(join(path, ".git"))` 区分 `not_git` 和 `no_remote`。
- [ ] **Step 4:** 再跑，预期 PASS。
- [ ] **Step 5: 提交** `feat(lessons): shared types and repo identity from git remote`。

---

### Task 2: 第 21 条迁移和 LessonsRepo

**Files:**
- Modify: `src/main/db/migrations.ts`（末尾追加）
- Create: `src/main/db/lessons-repo.ts`
- Test: `src/main/db/lessons-repo.test.ts`

迁移的表结构（照写）：
```sql
CREATE TABLE lesson_repos (
  slug TEXT PRIMARY KEY, local_path TEXT NOT NULL,
  merged_cursor TEXT,             -- 已经排进队列的最新合并时间（ISO，gh 原样）
  backfilled_at INTEGER, last_analyzed_at INTEGER, analyzed_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE TABLE lesson_products (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE lesson_product_repos (
  product_id INTEGER NOT NULL REFERENCES lesson_products(id) ON DELETE CASCADE,
  repo_slug TEXT NOT NULL REFERENCES lesson_repos(slug) ON DELETE CASCADE,
  PRIMARY KEY (product_id, repo_slug));
CREATE TABLE lessons (
  id INTEGER PRIMARY KEY,
  repo_slug TEXT REFERENCES lesson_repos(slug) ON DELETE CASCADE,
  product_id INTEGER REFERENCES lesson_products(id) ON DELETE CASCADE,
  text TEXT NOT NULL, why TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','disabled','rejected')),
  hits INTEGER NOT NULL DEFAULT 1, last_seen_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK ((repo_slug IS NULL) <> (product_id IS NULL)));
CREATE TABLE lesson_sources (
  id INTEGER PRIMARY KEY, lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL, url TEXT, at INTEGER NOT NULL,
  UNIQUE (lesson_id, pr_number, url));
CREATE TABLE lesson_queue (
  id INTEGER PRIMARY KEY, repo_slug TEXT NOT NULL REFERENCES lesson_repos(slug) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('backfill','merged','daily')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','skipped','failed')),
  error TEXT, enqueued_at INTEGER NOT NULL, finished_at INTEGER, not_before INTEGER,
  UNIQUE (repo_slug, pr_number));
CREATE INDEX lesson_queue_status ON lesson_queue(status, enqueued_at);
```

**Interfaces:**
- Consumes: Task 1 的类型。
- Produces：
  ```ts
  export interface LessonRepoRow { slug: string; localPath: string; mergedCursor: string | null; backfilledAt: number | null; lastAnalyzedAt: number | null; analyzedCount: number }
  export interface QueueItem { id: number; slug: string; prNumber: number; origin: "backfill" | "merged" | "daily" }
  export interface NewLesson { scope: LessonScope; text: string; why: string; at: number; source: { prNumber: number; url: string | null } }
  export class LessonsRepo {
    constructor(db: Db);
    upsertRepo(slug: string, localPath: string, now: number): void;   // 已有就只更新 local_path
    repos(): LessonRepoRow[]; repo(slug: string): LessonRepoRow | null;
    setBackfilled(slug: string, at: number): void;
    advanceCursor(slug: string, mergedAt: string): void;               // 只往后推（字符串比较，ISO 可比）
    createProduct(name: string, slugs: string[], now: number): number; deleteProduct(id: number): void;
    addToProduct(id: number, slug: string): void; removeFromProduct(id: number, slug: string): void;
    products(): LessonProductView[]; productsOf(slug: string): LessonProductView[];
    lessons(filter?: { status?: LessonStatus[]; scope?: LessonScope }): Lesson[];   // 带 sources
    get(id: number): Lesson | null;
    addLesson(l: NewLesson): number;                                    // status = pending, hits = 1
    /** 又出现一次：hits+1、last_seen_at、加一条出处（同一出处重复时 hits 不加）。 */
    hit(id: number, at: number, source: { prNumber: number; url: string | null }): void;
    setStatus(id: number, s: LessonStatus, now: number): void; setText(id: number, text: string, now: number): void;
    remove(id: number): void;
    /** keep 收下 drop 的出处、hits 相加、last_seen_at 取大，text 换成新的；drop 删掉。一个事务。 */
    merge(keepId: number, dropId: number, text: string, now: number): void;
    source(id: number): LessonSource | null;
    enqueue(slug: string, prs: number[], origin: QueueItem["origin"], now: number): number;  // 已有的行：failed 的改回 queued，其余不动；返回新排进去的个数
    take(now: number): QueueItem | null;     // 最早的 queued 且 not_before 为空或 <= now，改成 running
    finish(id: number, status: "done" | "skipped" | "failed", now: number, error?: string): void;  // done 时更新 lesson_repos 的 last_analyzed_at 和 analyzed_count
    defer(id: number, notBefore: number): void;   // 回到 queued
    resetRunning(): number;                       // 启动时 running → queued
    queueCounts(slug: string): { queued: number; failed: number };
  }
  ```

- [ ] **Step 1: 写失败的测试** `lessons-repo.test.ts`（`memDb()`）：
  - 迁移：`user_version` 等于 `MIGRATIONS.length`（21）。
  - `lessons` 表不允许 `repo_slug` 和 `product_id` 同时为空或同时有值（直接插入，预期抛错）。
  - `hit` 两次、出处相同：`hits` 是 2 而不是 3。`merge`：keep 的 hits 是两条之和，出处是两条的并集，drop 查不到。
  - `enqueue("acme/web", [1, 2], "backfill")` 返回 2；再 `enqueue(..., [2, 3], "daily")` 返回 1。把 2 `finish` 成 failed 之后再 `enqueue(..., [2])`，2 回到 queued。
  - `take` 按 enqueued_at 取，取到的变成 running；`defer(id, now + 600_000)` 之后 `take(now)` 取不到它，`take(now + 600_000)` 能取到。`resetRunning()` 把 running 改回 queued，返回个数。
  - `advanceCursor` 不会往回退：先 `"2026-11-10T00:00:00Z"`，再 `"2026-11-01T00:00:00Z"`，结果还是 11-10。
  - `deleteProduct` 连带删掉这个产品的规矩。
- [ ] **Step 2:** `npx vitest run src/main/db/lessons-repo.test.ts`，预期 FAIL。
- [ ] **Step 3: 实现。** 迁移照上面的 SQL；repo 照 `pr-stage-repo.ts` 的写法，`Row → toLesson`；`merge` 用 `withTransaction`。
- [ ] **Step 4:** 再跑，并跑 `npx vitest run src/main/db`，预期全部 PASS（其他迁移测试断言的是 `MIGRATIONS.length`，不受影响）。
- [ ] **Step 5: 提交** `feat(lessons): lessons tables and repo`。

---

### Task 3: gh 新加三个调用

**Files:**
- Modify: `src/main/tickets/gh.ts`
- Test: `src/main/tickets/gh.test.ts`（用现有的 `fakeGh`）

**Interfaces:**
- Consumes: 现有的 `PrReview`、`PrComment`、`reviewComments`、`reviewAuthors`、`runGh`、`parseJson`、`parseLines`。
- Produces：
  ```ts
  export const LESSON_GH_TIMEOUT_MS = 15_000;
  export interface MergedPr { number: number; mergedAt: string; headRefName: string }
  /** gh pr list --state merged --limit <limit> --json number,mergedAt,headRefName [--search "merged:><after>"]；按 mergedAt 升序返回。 */
  export function mergedPrs(cwd: string, after: string | null, limit: number, timeoutMs: number): Promise<MergedPr[] | null>;
  export interface PrCommit { oid: string; committedDate: string; headline: string; body: string }
  export interface PrLessonData {
    number: number; title: string; body: string; url: string; author: string; headRefName: string; mergedAt: string | null;
    reviews: PrReview[]; comments: PrComment[]; inline: PrComment[]; commits: PrCommit[];
    /** reviewAuthors 的结果；拿不到时为空集合。 */ botLogins: Set<string>;
  }
  /** gh pr view <n> --json number,title,body,url,author,headRefName,mergedAt,reviews,comments,commits，再加 reviewComments 和 reviewAuthors；任何一步失败返回 null。 */
  export function prLessonData(cwd: string, number: number, timeoutMs: number): Promise<PrLessonData | null>;
  /** gh api repos/{owner}/{repo}/compare/<base>...<head> --jq '.files[] | {filename, patch}'；没有 patch 的文件（二进制）patch 为 ""。 */
  export function compareFiles(cwd: string, base: string, head: string, timeoutMs: number): Promise<{ filename: string; patch: string }[] | null>;
  ```

- [ ] **Step 1: 写失败的测试**（加在 `gh.test.ts` 的 `describe.skipIf(win32)` 里）：
  - `mergedPrs`：fakeGh 把收到的参数写进文件，返回两行，mergedAt 是乱序的。断言：结果按 mergedAt 升序；`after = "2026-11-01T00:00:00Z"` 时，参数里有 `--search` 和 `merged:>2026-11-01T00:00:00Z`；`after = null` 时参数里没有 `--search`。gh 退出码非 0 → `null`。
  - `prLessonData`：fakeGh 按 `$1 $2` 分派（`pr view`、`api */comments`、`api */reviews`），断言 `commits[0].headline`、`inline.length`、`botLogins.has("coderabbitai")`。`pr view` 失败 → `null`。
  - `compareFiles`：断言 `[{ filename: "a.ts", patch: "@@ ..." }]`；文件没有 patch 时为 `""`。
- [ ] **Step 2:** `npx vitest run src/main/tickets/gh.test.ts`，预期 FAIL。
- [ ] **Step 3: 实现。**
  - maxBuffer：`prLessonData` 用 16MB，其余两个用 8MB。
  - `commits` 从 gh 的 `{oid, committedDate, messageHeadline, messageBody}` 映射过来。
  - reviews 和 comments 的映射复用 `prStatus` 里现有的函数。没有可复用的就抽成私有函数，两边一起用，不复制。
- [ ] **Step 4:** 再跑，预期 PASS。
- [ ] **Step 5: 提交** `feat(lessons): gh calls for merged PRs, review data and compare`。

---

### Task 4: 素材

**Files:**
- Create: `src/main/lessons/material.ts`
- Test: `src/main/lessons/material.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `PrLessonData`；`reviewerKind(login, prAuthor)`（`gh.ts`）。
- Produces：
  ```ts
  export type Who = "copilot" | "human" | "author" | "bot";
  export interface ReviewItem { who: Who; author: string; body: string; url: string | null; path: string | null; line: number | null; at: string }
  /** 只留 copilot 和 human、正文非空的 review、评论和行内评论；按时间升序。who 用 reviewerKind，login 在 botLogins 里的 human 改成 bot。 */
  export function reviewItems(pr: PrLessonData): ReviewItem[];
  /** 最早一条有 path 的行内评论之前最后一个 commit 的 oid，和最后一个 commit 的 oid；没有行内评论或评论之后没有 commit 时为 null。 */
  export function fixRange(pr: PrLessonData, items: ReviewItem[]): { base: string; head: string } | null;
  /** 从 JSONL 对话记录里取 assistant 的文字块（不要 tool_use、thinking），只留提到任一 path 的文件名（basename）的；从新到旧，合计不超过 maxChars。 */
  export function transcriptExcerpts(jsonl: string[], paths: string[], maxChars: number): string[];
  export interface Material {
    pr: PrLessonData; items: ReviewItem[];
    /** 评论指到的那几个文件在修改之后的 patch，每个最多 4000 字。 */ fixes: { filename: string; patch: string }[];
    /** Shipherd 做的 PR：handoff 里的 decisions 和 learnings，以及对话记录摘录；不是 Shipherd 做的为 null。 */
    shipherd: { ticketKey: string; decisions: string[]; learnings: string[]; excerpts: string[] } | null;
  }
  export const MATERIAL_MAX_CHARS = 60_000;
  /** 拼成 prompt 里的素材一节；超过 MATERIAL_MAX_CHARS 时依次截掉 excerpts、fixes 和 items 的正文（每条最多 1500 字）。 */
  export function materialText(m: Material, lang: Lang): string;
  ```

- [ ] **Step 1: 写失败的测试** `material.test.ts`：
  - `reviewItems` 会丢掉这些：作者自己的评论、`github-actions` 的评论、`botLogins` 里的 `coderabbitai`，以及正文为空的 APPROVED review。它保留 `copilot-pull-request-reviewer` 的行内评论（who 为 `copilot`）和 `alice` 的评论（who 为 `human`）。只有作者评论和 bot 评论的 PR 返回 `[]`。
  - `fixRange`：commits 是 c1（10:00）、c2（11:00）、c3（12:00），行内评论在 10:30 → `{ base: "c1", head: "c3" }`。评论在 12:30 → `null`。
  - `transcriptExcerpts`：三行 JSONL 依次是一个提到 `src/a.ts` 的 assistant 文字块、一个 tool_use、一个 user 消息，`paths = ["x/src/a.ts"]` → 只返回第一行的文字。`maxChars` 截断时保留最新的那条。
  - `materialText`：把素材撑到 200k 字，结果的长度不超过 `MATERIAL_MAX_CHARS`，里面仍然有每条 item 的作者。
- [ ] **Step 2:** `npx vitest run src/main/lessons/material.test.ts`，预期 FAIL。
- [ ] **Step 3: 实现。** 都是纯函数，不读文件。对话记录由 Task 6 读进来后传入。
- [ ] **Step 4:** 再跑，预期 PASS。
- [ ] **Step 5: 提交** `feat(lessons): review material from a merged PR`。

---

### Task 5: 分析：prompt、schema、applyAnalysis

**Files:**
- Create: `src/main/lessons/analyze.ts`
- Test: `src/main/lessons/analyze.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `LessonsRepo`（`lessons`、`addLesson`、`hit`、`productsOf`），Task 4 的 `Material`、`materialText`。
- Produces：
  ```ts
  export const AnalysisSchema: z.ZodType<Analysis>;   // 下面的结构；toCliJsonSchema(AnalysisSchema) 给 --json-schema
  export interface Analysis {
    findings: Array<{
      comment_url: string | null; summary: string;
      avoidable: boolean; why_missed: string;
      rule: null | { text: string; why: string; scope: "repo" | "product"; product_id: number | null; same_as: number | null };
    }>;
  }
  /** existing 包含这个仓库和它所属产品的规矩，四种状态都要，带上 id 和状态，让 claude 能指出"意思一样"。 */
  export function analysisPrompt(lang: Lang, slug: string, m: Material, existing: Lesson[], products: LessonProductView[]): string;
  export interface ApplyResult { created: number; hit: number; dropped: number }
  export function applyAnalysis(repo: LessonsRepo, slug: string, prNumber: number, a: Analysis, now: number): ApplyResult;
  ```

`applyAnalysis` 的规则（照写）：
- 只处理 `avoidable && rule` 的 finding。
- `same_as` 指向的规矩存在，并且属于这个仓库或这个仓库所属的某个产品：
  - 状态是 `rejected`：丢掉（dropped+1）。
  - 其他状态：`hit`（hit+1），出处是 `{ prNumber, url: comment_url }`。
- `same_as` 为 null 或指向不存在、不相关的 id：新建。
  - `scope === "product"` 且 `product_id` 是这个仓库所属的产品：挂到那个产品。
  - 其他情况挂到仓库。
  - 新建的状态都是 pending（created+1）。
- 同一次分析里两个 finding 的 `same_as` 相同时，各算一次 hit。出处相同的那次，hits 不加（`hit` 已经保证）。

prompt 的要点（措辞留给实现的人，这些内容必须有）：
- 目标：找出 review 挑出来、开发时本来能避免的问题，把它们提炼成下次写代码时就照着做的规矩。
- 规矩要写成可以照做的一句话，用界面语言写，不提具体的 PR 号或文件名，除非这条规矩就是针对那个文件的。
- 纯属个人偏好、只和这个 PR 的需求有关、review 者自己说错了的，`avoidable` 为 false。
- 已有规矩的列表写成 `#id [状态] 正文`，注明驳回过的不要再提。
- 产品列表写成 `product_id 名字：仓库…`，跨仓库的规矩才用 `scope: "product"`。

- [ ] **Step 1: 写失败的测试** `analyze.test.ts`（`memDb()` 加 `LessonsRepo`，先 `upsertRepo("acme/web")` 和 `createProduct("shop", ["acme/web", "acme/api"])`）：
  - 新规矩，`scope: "repo"` → 一条 pending，挂在 `acme/web`，出处是 PR 7 加评论链接。
  - `scope: "product"`、`product_id` 是 shop → 挂到 shop。`product_id` 是一个不相关的产品 → 挂到仓库。
  - `same_as` 指向已确认的规矩 → hits 从 1 变成 2，状态还是 confirmed，没有新规矩。
  - `same_as` 指向 rejected → 什么都不变，`dropped === 1`。
  - `same_as: 9999` → 新建一条 pending。
  - `avoidable: false` 的 finding 被忽略。
  - `analysisPrompt("zh", ...)` 含已有规矩的 `#id`、`[rejected]` 或对应的中文标记，以及产品的 `product_id`。
  - `toCliJsonSchema(AnalysisSchema)` 的 `properties` 有 `findings`。Task 10 的假 claude 靠这个键认出这次调用。
- [ ] **Step 2:** `npx vitest run src/main/lessons/analyze.test.ts`，预期 FAIL。
- [ ] **Step 3: 实现。** `applyAnalysis` 整个包在一个 `withTransaction` 里。
- [ ] **Step 4:** 再跑，预期 PASS。
- [ ] **Step 5: 提交** `feat(lessons): analysis prompt, schema and applying results`。

---

### Task 6: LessonRunner：队列、回溯、每日拉取、合并时排队

**Files:**
- Create: `src/main/lessons/lesson-runner.ts`
- Modify: `src/main/prwatch/pr-watcher.ts`（`PrWatcherDeps` 新加 `onMerged?`）
- Modify: `src/main/db/jobs-repo.ts`（`JOB_LESSONS_DAILY = "lessons_daily"`，加进 `JobName`）
- Modify: `src/main/index.ts`（建 `LessonsRepo`、`RepoIdentity`、`LessonRunner`，接上 `checkSchedule`、`onMerged`、退出）
- Test: `src/main/lessons/lesson-runner.test.ts`、`src/main/prwatch/pr-watcher.test.ts`

**Interfaces:**
- Consumes: Task 2–5。还用到这些：
  - `execHeadlessJson` 和 `HeadlessExecDeps`
  - `headlessArgs`
  - `HandoffsRepo.listByTicket`
  - `SessionsRepo.listByTicket` 和 `chainOf`
  - `findTranscript`
  - `TicketsRepo`
- Produces：
  ```ts
  export const LESSON_CONCURRENCY = 2;
  export const BACKFILL_LIMIT = 100;
  export const RATE_LIMIT_PAUSE_MS = 10 * 60_000;
  export interface LessonRunnerDeps {
    repo: LessonsRepo; identity: RepoIdentity; jobs: JobsRepo;
    gh: { mergedPrs: typeof mergedPrs; prLessonData: typeof prLessonData; compareFiles: typeof compareFiles; available: () => boolean };
    headless: HeadlessExecDeps;
    /** PR 分支 → Shipherd 的 ticket：在所有 ticket_repos（包括归档的）里找 branch 相同、slugOf(repo_path) 相同的那一行。 */
    ticketForBranch: (slug: string, branch: string) => string | null;
    shipherdContext: (ticketKey: string) => { decisions: string[]; learnings: string[]; transcripts: string[][] };
    lang: () => Lang; now: () => number; notify: () => void; log?: (msg: string, e?: unknown) => void;
  }
  export class LessonRunner {
    constructor(d: LessonRunnerDeps);
    /** 启动时调一次：resetRunning，然后 pump。 */
    start(): void;
    /** 页面的「分析历史」。没有 gh、解析不出 slug 时返回原因，不排队。 */
    backfill(slug: string): Promise<{ ok: true; enqueued: number } | { ok: false; reason: "no_gh" | "gh_failed" | "unknown_repo" }>;
    /** PR 监视看到 Shipherd 跟踪的 PR 合并时调用。 */
    merged(repoPath: string, prNumber: number): void;
    /** checkSchedule 每次调；今天已经跑过就什么都不做。 */
    daily(): Promise<void>;
    /** 测试用：等当前所有任务跑完。 */
    idle(): Promise<void>;
  }
  ```
- PrWatcher：`onMerged?: (t: PrTarget, prNumber: number) => void`。在 `record()` 里，只有 kind 为 `merged` 的事件 `stages.add` 返回 true（第一次看到）时才调。没有 `stages` 时，在 `checkOne` 看到 `prev.state !== "merged" && next.state === "merged"` 时调。

一个队列项的处理流程（照写）：
1. 用 `repo(slug).localPath` 做 cwd 调 `prLessonData`。返回 null 时 `finish(failed, "gh")`。
2. `reviewItems` 为空时 `finish(skipped)`，不调 claude。
3. `fixRange` 有值时调 `compareFiles`，只留评论指到的那几个文件。这一步失败就当没有 fixes，不算失败。
4. `ticketForBranch` 找到 ticket 时，用 `shipherdContext` 填 `Material.shipherd`。`transcriptExcerpts` 的上限是 20_000 字。
5. 调 `execHeadlessJson`，label 是 `lessons`，参数是 `headlessArgs({ schema: toCliJsonSchema(AnalysisSchema), allowedTools: [] })`。结果按 reason 处理：
   - `rate_limited`：`defer(now + RATE_LIMIT_PAUSE_MS)`，并且在这个时间之前整个 runner 都不再 take。
   - `aborted`：`defer(now)`，回到队列。
   - 其他失败：`finish(failed, reason)`。
6. `validate(AnalysisSchema, value)` 不通过时 `finish(failed, "bad_output")`。通过就 `applyAnalysis`，然后 `finish(done)`，再 `notify()`。

`pump()` 在这些时候调：`start`、`enqueue` 之后、每个任务结束后。正在跑的少于 `LESSON_CONCURRENCY` 时就 take 下一个。`headless.signal` 已经 aborted 时不再 take。

`daily()` 的规则：
- `jobs.get(JOB_LESSONS_DAILY).lastRunAt` 早于今天 0 点（`dayStart`）才跑。
- 只拉 `backfilledAt` 不为空的仓库，对每个仓库调 `mergedPrs(localPath, mergedCursor, BACKFILL_LIMIT)`。
- 排队用 origin `daily`，然后用最大的 mergedAt 调 `advanceCursor`。
- 最后 `jobs.record`。

`backfill()` 的规则：
- `mergedPrs(localPath, null, BACKFILL_LIMIT)`，排队用 origin `backfill`。
- 然后 `setBackfilled`，并用最大的 mergedAt 调 `advanceCursor`。

`merged()` 的规则：
- `identity.slugOf(repoPath)` 为 null 就不做。
- 否则先 `upsertRepo(slug, repoPath)`，再用 origin `merged` 排队。不要求这个仓库分析过历史。

- [ ] **Step 1: 写失败的测试** `lesson-runner.test.ts`（真的 `LessonsRepo` 加 `memDb()`，gh 和 `headless.run` 都是假的）：
  - **并发：** 排 5 个 PR，假 `run` 挂起直到手动放行。断言同时最多 2 个在跑。全部放行后，5 个都是 done，`analyzed_count === 5`。
  - **跳过：** 只有作者评论的 PR 是 skipped，`run` 没被调用。
  - **gh 失败：** `prLessonData` 返回 null → failed，error 是 `"gh"`，这一轮不再重试。
  - **rate_limited：** 那一项回到 queued，`not_before` 是 now+10 分钟；在这之前 `pump` 不 take 任何一项。
  - **重启：** 把一项手动设成 running，新建一个 runner 调 `start()`，它被重新处理。
  - **结果写进去：** 假 claude 返回一条新规矩 → 一条 pending。`notify` 被调用。
  - **Shipherd 的 PR：** `ticketForBranch` 返回 `"BTL-1"` 时，`run` 收到的 prompt 里有 `shipherdContext` 给的 decision 原文。
  - **backfill：** 没有 gh 时返回 `{ ok: false, reason: "no_gh" }`；`mergedPrs` 返回 null 时返回 `"gh_failed"`；成功时 `enqueued` 等于 PR 数，`backfilledAt` 有值，cursor 是最大的 mergedAt。
  - **daily：** 同一天调两次，`mergedPrs` 只调一次；没分析过历史的仓库不拉；第二天会再拉，并且带上 cursor。
  - **merged：** `slugOf` 为 null 时不排队；不为 null 时排一项，origin 是 `merged`。
  - pr-watcher.test.ts：PR 从 open 变成 merged，`onMerged` 被调用一次；下一轮看到同样的数据，不会再调。
- [ ] **Step 2:** `npx vitest run src/main/lessons src/main/prwatch`，预期 FAIL。
- [ ] **Step 3: 实现，并在 index.ts 接线。**
  - `headless` 是 `{ ...judgeDeps }`，用默认的 `HEADLESS_TIMEOUT_MS`。
  - `gh.available` 用 `() => ghBinary() !== null`。
  - `ticketForBranch` 和 `shipherdContext` 在 index.ts 里用现有的 repo 写成小函数：`TicketsRepo` 列所有 ticket_repos，包括归档的。没有现成方法时，在 `TicketsRepo` 加 `reposByBranch(branch): TicketRepo[]`。`shipherdContext` 读最近 20 份 handoff 的 `decisions[].statement` 和 `learnings`，再读这个 ticket 每个 session 的 `chainOf` 里每段的 JSONL。
  - `checkSchedule` 里加 `void lessonRunner.daily()`。
  - `healthReady` 之后调 `lessonRunner.start()`。
  - `PrWatcher` 的 `onMerged` 接到 `(t, n) => lessonRunner.merged(t.repoPath, n)`。
- [ ] **Step 4:** 再跑，预期 PASS。再跑 `pnpm -s typecheck && pnpm -s lint`。
- [ ] **Step 5: 提交** `feat(lessons): persistent analysis queue, backfill, daily pull and merge hook`。

---

### Task 7: 规矩送进 session

**Files:**
- Create: `src/main/lessons/select.ts`
- Modify: `src/main/claude/session-guide.ts`、`src/main/sessions/session-service.ts`、`src/main/index.ts`
- Test: `src/main/lessons/select.test.ts`、`src/main/claude/session-guide.test.ts`、`src/main/sessions/session-service.test.ts`、`src/main/sessions/feature-sessions.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RepoIdentity`、`SessionLesson`、`MAX_SESSION_LESSONS`，Task 2 的 `LessonsRepo`。
- Produces：
  ```ts
  // select.ts
  /** 这些仓库路径 → slug（去重、去掉解析不出的）→ 仓库的规矩和这些仓库所属产品的规矩，只要 confirmed；排序后取前 limit 条。 */
  export function sessionLessons(repo: LessonsRepo, identity: RepoIdentity, repoPaths: string[], limit?: number): SessionLesson[];
  /** 只开这一个仓库时，已确认的规矩（仓库的加上所属产品的）超过 limit 的条数。 */
  export function overflowFor(repo: LessonsRepo, slug: string, limit?: number): number;
  /** 同一个 ticket 或 feature 里一起出现过 ≥2 次的仓库组合（按 slug），已经全在同一个产品里的不算。 */
  export function productSuggestions(groups: string[][], products: LessonProductView[]): LessonProductSuggestion[];
  // session-guide.ts
  export function sessionGuide(lang: Lang, kind: GuideKind, lessons?: SessionLesson[]): string;
  /** lessons 为空：照旧写 guide-<kind>-<lang>.md。不为空：写 guide-<kind>-<lang>-<sha256 前 12 位>.md。 */
  export function writeSessionGuide(mcpDir: string, lang: Lang, kind: GuideKind, lessons?: SessionLesson[]): string;
  /** 删掉 mcpDir 里 30 天没改过的 guide-*-*-<hash>.md；启动时调一次。 */
  export function pruneSessionGuides(mcpDir: string, now: number): number;
  // session-service.ts
  guidePath?: (kind: GuideKind, repoPaths: string[]) => string | null;
  ```

规矩那一段（只给 `kind === "ticket"` 且 lessons 不为空，放在 `GUIDE_SECTIONS` 的输出之后）：
- 中文开头："下面是从这个仓库以前的 review 里总结出来、用户确认过的规矩。写代码时就照着做；做自我 review 时逐条对照，在 report 里写明对照的结果（哪几条相关、有没有违反、改了什么）。"
- 英文开头意思一样。
- 之后每条一行：`- [<label>] <text>`。

session 涉及哪些仓库路径（`repoPaths`）：
- ticket session（`open()`，不是 coordinator）：`ticket.repos.map(r => r.repoPath)`。
- ticket 总控：传 `[]`，kind 是 `coordinator`，本来就不加规矩。
- 修复 session：
  - 被修的 session 是 `sessions.head(fixesSession)`。它有 `ticketKey` 时，用那个 ticket 的 `repos`。
  - 否则用 `feature.repos`。
  - 新建时 `fixes` 来自参数；恢复时用 `head.fixesSession`。
- 修复 session 恢复时 kind 也要对：`startInFeature` 里的 `from.fixes` 改成 `from.fixes ?? from.head?.fixesSession ?? undefined`，`guideKind` 和 `row` 都按它来。
- 其他 kind 传 `[]`。

index.ts 的接线：
```ts
guidePath: (kind, repoPaths) =>
  writeSessionGuide(paths.mcp, currentLang(), kind, kind === "ticket" ? sessionLessons(lessonsRepo, repoIdentity, repoPaths) : [])
```
启动时调一次 `pruneSessionGuides(paths.mcp, Date.now())`。

- [ ] **Step 1: 写失败的测试。**
  - **select.test.ts：**
    - 两个仓库各 15 条已确认，所属产品 10 条已确认，另有 3 条 pending、2 条 disabled。断言：结果正好 30 条；没有 pending 和 disabled 的正文；第一条是 hits 最大的。hits 相同时，last_seen_at 新的在前。
    - 解析不出 slug 的路径被忽略。
    - 两个路径解析成同一个 slug 时，规矩不重复。
    - `overflowFor` 在仓库 25 条、产品 10 条时是 5。
    - `productSuggestions([["a/web","a/api"],["a/web","a/api"],["a/web","b/x"]], [])` → `[{ slugs: ["a/api","a/web"], together: 2 }]`；同一组已经在一个产品里时 → `[]`。
  - **session-guide.test.ts：**
    - `sessionGuide("zh", "ticket", [{ label: "acme/web", text: "改 schema 要加迁移" }])` 含"逐条对照"和 `- [acme/web] 改 schema 要加迁移`。
    - `sessionGuide("zh", "coordinator", 同样的 lessons)` 不含 `acme/web`。
    - `writeSessionGuide(dir, "zh", "ticket", lessons)` 的文件名形如 `guide-ticket-zh-<12 位 hex>.md`，lessons 相同时路径相同；不传 lessons 时还是 `guide-ticket-zh.md`，原来那条测试不改。
    - `pruneSessionGuides`：31 天前的 hash 文件被删，1 天前的和 `guide-ticket-zh.md` 都留着。
  - **session-service.test.ts：** ticket session 的 `guidePath` 收到 `("ticket", [ticket 所有仓库的 repoPath])`；ticket 总控收到 `("coordinator", [])`。
  - **feature-sessions.test.ts：**
    - 新开修复 session，`guidesAsked` 收到 `("ticket", 被修的那个 ticket 的仓库路径)`。
    - 关掉后通过 `openFeature` 恢复，仍然是 `"ticket"`，仓库路径也一样。这条现在会失败，因为恢复时变成了 `"coordinator"`。
    - 被修的 session 没有 ticket 时，用 feature 的仓库。
- [ ] **Step 2:** `npx vitest run src/main/lessons src/main/claude src/main/sessions`，预期 FAIL。
- [ ] **Step 3: 实现。**
  - `guidesAsked` 这类测试辅助要跟着新签名改。
  - hash 用 `createHash("sha256")`，算的是整个文件的内容。
- [ ] **Step 4:** 再跑，预期 PASS。
- [ ] **Step 5: 提交** `feat(lessons): confirmed lessons in ticket and fix session guides`。

---

### Task 8: LessonsService 和 IPC

**Files:**
- Create: `src/main/lessons/lessons-service.ts`
- Modify: `src/shared/ipc.ts`、`src/main/ipc/register.ts`、`src/main/ipc/validate.ts`、`src/renderer/src/api.ts`、`src/main/index.ts`
- Test: `src/main/lessons/lessons-service.test.ts`、`src/main/ipc/validate.test.ts`、`src/shared/ipc.test.ts`

**Interfaces:**
- Consumes: Task 2、6、7。
- Produces：
  ```ts
  export interface LessonsServiceDeps {
    repo: LessonsRepo; identity: RepoIdentity; runner: Pick<LessonRunner, "backfill">;
    /** Shipherd 知道的所有仓库根路径（ticket_repos、feature_repos、epic_repos 的 repo_path 去重）。 */
    knownRepoPaths: () => string[];
    /** 每个 ticket 和每个 feature 的仓库根路径，一组一个数组，给归组建议用。 */
    repoGroups: () => string[][];
    ghAvailable: () => boolean; openExternal: (url: string) => void; now: () => number; notify: () => void;
  }
  export class LessonsService {
    constructor(d: LessonsServiceDeps);
    /** 先把 knownRepoPaths 里解析得出的 upsertRepo，再拼视图。 */
    state(): LessonsState;
    act(a: LessonAction): Promise<{ ok: true } | { ok: false; reason: string }>;
    pendingCount(): number;
  }
  // shared/ipc.ts
  lessonsState: "lessons:state", lessonsAct: "lessons:act", lessonsPending: "lessons:pending"   // 都进 INVOKE_CHANNELS
  // validate.ts
  export function lessonActionArg(v: unknown): LessonAction;   // 字段不对就抛错；text 和 name 去掉首尾空白后不能为空，最长 2000 字
  // api.ts
  lessonsState: () => call<LessonsState>(IPC.lessonsState),
  lessonsAct: (a: LessonAction) => call<{ ok: true } | { ok: false; reason: string }>(IPC.lessonsAct, a),
  lessonsPending: () => call<number>(IPC.lessonsPending),
  ```

`act` 的规则：
- **改规矩的几种动作：** `confirm` 带 text 时，先 `setText` 再确认。`merge` 要求两条属于同一个 scope，否则返回 `{ ok: false, reason: "scope_mismatch" }`。
- **建产品：** `createProduct` 的名字已经存在时，返回 `{ ok: false, reason: "name_taken" }`。
- **openSource：** 只打开 `https:` 开头的 url，用 Electron 的 `shell.openExternal`，在 index.ts 里注入。其他的返回 `{ ok: false, reason: "bad_url" }`。
- **backfill：** 原样返回 runner 的结果。
- **每个动作成功以后都调 `notify()`。**

`state` 怎么算：
- `repos` 按 slug 排序。
- `unknownRepos` 来自 `identity.resolve` 失败的路径。
- `overflow` 用 `overflowFor` 算。
- `suggestions` 由 `productSuggestions` 算，传进去的是 `repoGroups` 映射成的 slug。

- [ ] **Step 1: 写失败的测试。**
  - **lessons-service.test.ts：**
    - `state()` 把三个已知路径分成两个 repos 和一个 unknownRepos（reason 是 `no_remote`）。两个路径解析成同一个 slug 时，只出现一个仓库。
    - `queued` 和 `failed` 是对的。`overflow` 在 35 条已确认时是 5。
    - `lessons` 里没有 rejected 的。
    - `act({ op: "confirm", id, text: "新正文" })` 以后，这条是 confirmed，正文是新的，`notify` 被调用。
    - `act({ op: "merge", ... })` 在两条属于不同 scope 时返回 `scope_mismatch`。
    - `act({ op: "openSource", sourceId })`：url 是 `javascript:...` 时不调 `openExternal`。
    - `pendingCount()` 只数 pending。
  - **validate.test.ts：**
    - `lessonActionArg({ op: "edit", id: 1, text: "  " })` 抛错。
    - `{ op: "nope" }` 抛错。
    - 合法的 `{ op: "backfill", slug: "acme/web" }` 原样返回。
  - **ipc.test.ts** 现有的检查会覆盖新加的 channel，不用改。
- [ ] **Step 2:** `npx vitest run src/main/lessons src/main/ipc src/shared`，预期 FAIL。
- [ ] **Step 3: 实现，并在 index.ts 接线。**
  - `knownRepoPaths` 和 `repoGroups` 用 db 查询写成小函数：在 `TicketsRepo`、`FeaturesRepo`、`EpicsRepo` 里各加一个只读方法，或者在 index.ts 里直接 `db.prepare`，二者选一。
  - 这几个查询都包括归档的 ticket。
- [ ] **Step 4:** 再跑，预期 PASS。
- [ ] **Step 5: 提交** `feat(lessons): lessons service and IPC`。

---

### Task 9: 「review 经验」页面

**Files:**
- Create: `src/renderer/src/components/LessonsPage.tsx`、`src/renderer/src/lessons-view.ts`
- Modify: `src/renderer/src/App.tsx`（`Route` 加 `{ page: "lessons" }`，渲染）、`components/Sidebar.tsx`（「审计」上面加一项）、`strings.ts`、`strings-en.ts`、`styles.css`
- Test: `src/renderer/src/lessons-view.test.ts`

**Interfaces:**
- Consumes: Task 8 的 `api.lessonsState`、`api.lessonsAct`、`api.lessonsPending`，Task 1 的类型。
- Produces：
  ```ts
  // lessons-view.ts
  export type LessonsSelection = { kind: "repo"; slug: string } | { kind: "product"; id: number };
  /** 左侧列表：每个产品一组（下面缩进列出它的仓库），然后是不属于任何产品的仓库；一个仓库属于多个产品时，在每个产品下面都出现。 */
  export function lessonsTree(s: LessonsState): Array<{ product: LessonProductView | null; slugs: string[] }>;
  /** 选中的仓库或产品自己的规矩，分成待确认和已确认（含停用的，停用的排在最后）。 */
  export function lessonsFor(s: LessonsState, sel: LessonsSelection): { pending: Lesson[]; confirmed: Lesson[] };
  // LessonsPage.tsx
  export function LessonsPage(): JSX.Element;
  ```

界面（照 spec 的「页面」一节）：
- **左侧菜单：** 「review 经验」在「审计」上面。有待确认的规矩时，后面带个数，形如 `review 经验 · 3`。个数由 `useStateRefetch("lessons-pending", api.lessonsPending)` 取。
- **数据刷新：** 页面数据用 `useStateRefetch("lessons", api.lessonsState)`，`stateChanged` 之后自动刷新。
- **顶部：** 产品和仓库的列表。每个仓库一行，显示：
  - 上次分析的时间（`S.lessonsLastAnalyzed`，没分析过显示 `S.lessonsNever`）
  - 分析过几个 PR，队列里还有几个，失败几个
  - 「分析历史」按钮

  `ghAvailable` 为 false 时，按钮不能点，悬停说明原因（`S.lessonsNoGh`）。`overflow > 0` 时，显示 `S.lessonsOverflow(n)`。`unknownRepos` 列在最下面，每个写明原因（`S.lessonsNoRemote`、`S.lessonsNotGit`）。
- **选中一项后：**
  - 「待确认」：每条显示正文、为什么提这条，以及出处。出处显示为 `#123`，点了调 `openSource`。三个按钮：
    - 确认
    - 编辑后确认（变成文本框，带保存并确认、取消）
    - 驳回
  - 「已确认」：每条显示正文、出现次数（`S.lessonsHits(n)`）、最后出现时间，以及出处。可以：
    - 编辑
    - 停用或启用
    - 删除（需要再点一次确认，同一个按钮变成 `S.lessonsDeleteConfirm`，不用浏览器弹窗）
  - 合并：勾选两条已确认的规矩时出现「合并」按钮，打开文本框，预填两条正文用换行连起来，保存后调 `merge`，keepId 取 hits 大的那条。
- **管理产品：**
  - 新建产品：输入名字，勾选仓库。
  - 产品下面的每个仓库后面有「移出」，产品后面有「加仓库」下拉框和「删除产品」。删除产品时提示连同几条规矩一起删，也是点两次确认。
  - 归组建议显示在这里：`S.lessonsSuggest(slugs, n)`，加一个「归成产品」按钮，点了以后，名字预填成第一个仓库的 name 部分。
  - spec 里写的是"拖进去或移出来"，这里用按钮和下拉框代替拖拽，功能一样，在 PR 里说明。
- **空状态：** 还没有任何仓库时，显示 `S.lessonsEmpty`。
- **出错：** `act` 返回 `{ ok: false }` 时，在那一条旁边显示原因（`S.lessonsError[reason]`，没有对应的就显示通用的）。

要加的字符串（ZH / EN 都加，下面列中文）：
- `lessons`：「review 经验」
- `lessonsIntro`：一句话说明规矩从哪来、确认后会送进 Shipherd 开的 ticket 和修复 session
- `lessonsPendingTitle`、`lessonsConfirmedTitle`
- `lessonsBackfill`：「分析历史」
- `lessonsLastAnalyzed(t)`、`lessonsNever`、`lessonsCounts(analyzed, queued, failed)`、`lessonsNoGh`、`lessonsNoRemote`、`lessonsNotGit`、`lessonsOverflow(n)`
- `lessonsConfirm`、`lessonsEditConfirm`、`lessonsReject`、`lessonsEdit`、`lessonsDisable`、`lessonsEnable`、`lessonsDelete`、`lessonsDeleteConfirm`、`lessonsMerge`
- `lessonsHits(n)`、`lessonsLastSeen(t)`
- `lessonsProducts`、`lessonsNewProduct`、`lessonsAddRepo`、`lessonsRemoveRepo`、`lessonsDeleteProduct(n)`、`lessonsSuggest(slugs, n)`、`lessonsMakeProduct`
- `lessonsEmpty`
- `lessonsError: Record<string, string>`（`scope_mismatch`、`name_taken`、`no_gh`、`gh_failed`、`unknown_repo`、`bad_url`）
- `lessonsNavCount(n)`

- [ ] **Step 1: 写失败的测试** `lessons-view.test.ts`：
  - `lessonsTree`：产品 shop 有 web 和 api，产品 admin 有 api 和 x，另有一个单独的仓库 y。断言 api 在 shop 和 admin 下面各出现一次，y 在最后那个 `product: null` 的组里。
  - `lessonsFor`：选中仓库时，只返回这个仓库自己的规矩，不含产品的；停用的规矩排在已确认的最后。
- [ ] **Step 2:** `npx vitest run src/renderer/src/lessons-view.test.ts`，预期 FAIL。
- [ ] **Step 3: 实现。**
  - 纯函数、页面、菜单、字符串、样式都在这一步做。样式用现有的 CSS 变量，深色模式也要能看清。
  - 页面结构参照 `AuditPage.tsx` 的 `.page` 和 `<h2>`。
- [ ] **Step 4:** 跑 `npx vitest run src/renderer && pnpm -s typecheck && pnpm -s lint`，预期 PASS。
- [ ] **Step 5: 提交** `feat(lessons): review lessons page and sidebar entry`。

---

### Task 10: 假 claude、端到端测试、README

**Files:**
- Modify: `e2e/fake-claude/fake-claude.cjs`
- Create: `e2e/lessons.spec.ts`
- Modify: `README.md`、`README.zh-CN.md`

- [ ] **Step 1: 写失败的 e2e** `e2e/lessons.spec.ts`（照 `features.spec.ts` 的开法，直接往 DB 里插数据）：
  1. sandbox 里的一个 git 仓库 `git remote add origin https://github.com/acme/web.git`，建一个用这个仓库的 ticket。
  2. 往 `lesson_repos` 插 `acme/web`，往 `lessons` 插两条 pending：A「改 schema 要加迁移」、B「不要在渲染进程调 gh」。
  3. 左侧菜单显示「review 经验 · 2」。点进去，选 `acme/web`，确认 A，驳回 B。之后菜单上没有个数，「已确认」里有 A，页面上看不到 B。
  4. 在 ticket 页打开 session。假 claude 的日志 `interactive new ... guide=<path>` 里有 guide 的路径，读那个文件，含 `- [acme/web] 改 schema 要加迁移`，不含 B。
  5. 回到页面停用 A，关掉 session 再打开。新的 guide 文件不含 A。
- [ ] **Step 2:** 跑 `pnpm -s build && pnpm -s build:hook && npx playwright test e2e/lessons.spec.ts`，预期 FAIL。
- [ ] **Step 3: 实现。**
  - **fake-claude：**
    - interactive 那行日志末尾加上 ` guide=${flag("--append-system-prompt-file") || ""}`。
    - headless 里，`props.findings` 存在时返回 `{ findings: [] }`，加在 needs_user 那几个分支之后。
    - 文件头的说明里各补一行。
  - **README（两份都改）：**
    - 「功能」一节加一小段「review 经验」：规矩从哪来、怎么确认、会送进哪些 session、最多 30 条、改了以后下次打开 session 才生效。
    - 「隐私模型」一节补一句：review 经验的分析会把 PR 的评论、相关代码改动，以及 Shipherd 的 handoff 和对话记录摘录交给你自己的 `claude`，不经过个人 LLM API。
    - 「数据存放位置」里 app.db 那一行，提到规矩也存在这里。
    - 写明规矩只存在 Shipherd 里，不会写进仓库。
- [ ] **Step 4:** 再跑上面的 e2e，预期 PASS。
- [ ] **Step 5: 全量验证。** `pnpm -s typecheck && pnpm -s lint && npx vitest run` 全部通过，`npx playwright test` 全部通过。
- [ ] **Step 6: 提交** `feat(lessons): e2e and README`。push 分支，开 PR。

---

## 这份计划没做、要说明的

- spec 里写着"也可以让后台 claude 给出合并建议"。这次只做用户在页面上手动合并，不做自动建议。
- spec 里写的是"每个 session 单独生成一个说明文件"。这里改成按内容 hash 成文件：内容一样的 session 共用一个文件，效果相同，而且不用为每个 session 清理文件。
- 产品管理用按钮和下拉框代替拖拽。
