// 刷新基准（BTL-265）用的大数据库：几十个 feature / ticket，每个 ticket 上百条带大 raw_text 的 handoff，
// 几千个外面开的 session，各 ticket 的 PR、CI、报告。路径都在沙盒里、不存在，Shipherd 不会去动真的仓库。
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SeedScale {
  features: number;
  ticketsPerFeature: number;
  looseTickets: number;
  handoffsPerTicket: number;
  /** 每条 handoff 的 raw_text 有多长（字符）。 */
  rawChars: number;
  sessionsPerTicket: number;
  discoveredSessions: number;
  featureHandoffs: number;
  reportsPerTicket: number;
}

export const REAL_SCALE: SeedScale = {
  features: 12, ticketsPerFeature: 6, looseTickets: 15, handoffsPerTicket: 100, rawChars: 6000,
  sessionsPerTicket: 6, discoveredSessions: 2000, featureHandoffs: 30, reportsPerTicket: 20,
};

const filler = (n: number, seed: string): string => {
  const unit = `${seed} 做了一些事情，改了几个文件，跑了测试，等 CI。 `;
  return unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
};

/** 往沙盒的 app.db（已经迁移好的）里写入基准数据；返回 feature id 和 ticket key。 */
export function seedRefreshBench(dbFile: string, root: string, scale: SeedScale = REAL_SCALE): { featureIds: number[]; ticketKeys: string[] } {
  const db = new DatabaseSync(dbFile);
  const now = Date.now();
  const day = 86_400_000;
  const featureIds: number[] = [];
  const ticketKeys: string[] = [];
  let pr = 1;
  let sid = 0;
  db.exec("BEGIN");
  try {
    const insFeature = db.prepare("INSERT INTO features (name, workspace_dir, created_at, brief) VALUES (?, ?, ?, ?)");
    const insBlock = db.prepare("INSERT INTO blocks (feature_id, name, description, position, created_at) VALUES (?, ?, NULL, ?, ?)");
    const insTicket = db.prepare(
      "INSERT INTO tickets (key, title, repo_path, work_mode, worktree_path, branch, status, created_at, feature_id) VALUES (?, ?, '', 'branch', NULL, '', ?, ?, ?)",
    );
    const insRepo = db.prepare("INSERT INTO ticket_repos (ticket_key, repo_path, work_mode, worktree_path, branch, created_at) VALUES (?, ?, 'worktree', ?, ?, ?)");
    const insSession = db.prepare(
      `INSERT INTO sessions (id, ticket_key, cwd, origin, first_prompt, last_activity_at, waiting_for_input, replaced_by, created_at, repo_id, coordinator, feature_id, hibernated_at, hibernate_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insHandoff = db.prepare("INSERT INTO handoffs (ticket_key, session_id, trigger, created_at, payload, degraded, raw_text) VALUES (?, ?, ?, ?, ?, 0, ?)");
    const insFeatureHandoff = db.prepare("INSERT INTO feature_handoffs (feature_id, session_id, trigger, created_at, payload, degraded, raw_text) VALUES (?, NULL, 'nightly', ?, ?, 0, ?)");
    const insPr = db.prepare(
      `INSERT INTO ticket_prs (ticket_key, url, slug, repo_id, number, head_branch, state, review, ci, head_sha, opened_at, merged_at, source, linked_at, checked_at, title, author, status_changed_at)
       VALUES (?, ?, 'acme/app', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'branch', ?, ?, ?, 'me', ?)`,
    );
    const insBranch = db.prepare("INSERT INTO branch_watch (repo_id, ticket_key, branch, ci, head_sha, checked_at) VALUES (?, ?, ?, 'passing', 'abc', ?)");
    const insOwner = db.prepare("INSERT INTO branch_owners (ticket_key, repo_id, branch, session_id, dir, at) VALUES (?, ?, ?, ?, ?, ?)");
    const insInbox = db.prepare(
      "INSERT INTO inbox_items (kind, session_id, ticket_key, feature_id, text, options, report_kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insRisk = db.prepare("INSERT INTO pr_risk (pr_id, head_sha, level, rules_version, computed_at) VALUES (?, ?, 'low', 1, ?)");

    const addTicket = (key: string, featureId: number | null, createdAt: number, hibernate: boolean) => {
      ticketKeys.push(key);
      insTicket.run(key, `工作 ${key}`, "active", createdAt, featureId);
      const repoId = Number(insRepo.run(key, join(root, "repos", "app"), join(root, "wt", key), `feature/${key}`, createdAt).lastInsertRowid);
      // session：一条 /clear 过三次的链，加几条旧的。
      const ids: string[] = [];
      for (let i = 0; i < scale.sessionsPerTicket; i++) ids.push(`s-${++sid}`);
      ids.forEach((id, i) => {
        const replacedBy = i < 2 ? ids[i + 1] : null;
        const hib = hibernate && i === 2 ? now - 60_000 : null;
        insSession.run(id, key, join(root, "wt", key), "butler", `做 ${key}`, now - i * 3_600_000, 0, replacedBy, createdAt + i, repoId, 0, null, hib, hib ? "idle" : null);
      });
      const head = ids[2];
      insBranch.run(repoId, key, `feature/${key}`, now);
      insOwner.run(key, repoId, `feature/${key}`, head, join(root, "wt", key), now);
      // PR：一个开着的，一个合了的。
      const openNo = pr++;
      const mergedNo = pr++;
      const openId = Number(insPr.run(key, `https://github.com/acme/app/pull/${openNo}`, repoId, openNo, `feature/${key}`, "open", null, openNo % 3 === 0 ? "failing" : "passing", "abc", now - day, null, now - day, now, `PR ${openNo}`, now - 3_600_000).lastInsertRowid);
      insRisk.run(openId, "abc", now);
      insPr.run(key, `https://github.com/acme/app/pull/${mergedNo}`, repoId, mergedNo, `feature/${key}-old`, "merged", "APPROVED", "passing", "def", now - 5 * day, now - 4 * day, now - 5 * day, now, `PR ${mergedNo}`, now - 4 * day);
      // handoff：越早的越旧，旧的里记着合了的 PR。
      for (let h = 0; h < scale.handoffsPerTicket; h++) {
        const at = createdAt + h * 600_000;
        const payload = {
          ticket: key, status: "in_progress",
          done_today: [filler(300, `${key}#${h}`)], next_steps: [filler(400, "next"), filler(200, "then")], blockers: [],
          prs: [
            { number: openNo, url: `https://github.com/acme/app/pull/${openNo}`, state: "open", review: null },
            { number: mergedNo, url: `https://github.com/acme/app/pull/${mergedNo}`, state: h < scale.handoffsPerTicket / 2 ? "open" : "merged", review: null },
          ],
          jira: null, followups: [], decisions: [filler(300, "decided")], learnings: [filler(300, "learned")], open_questions: [],
        };
        insHandoff.run(key, head, h % 10 === 0 ? "refresh" : "command", at, JSON.stringify(payload), filler(scale.rawChars, `${key} handoff ${h}`));
      }
      for (let r = 0; r < scale.reportsPerTicket; r++) {
        // 送到总控以后是 answered（pending 的只是还没找到总控的那一小会儿）。
        insInbox.run("report", head, key, featureId, filler(400, `report ${r}`), null, r % 5 === 0 ? "done" : "progress", "answered", now - (scale.reportsPerTicket - r) * 600_000);
      }
    };

    for (let f = 0; f < scale.features; f++) {
      const createdAt = now - (scale.features - f) * 2 * day;
      const fid = Number(insFeature.run(`Epic ${f + 1}`, join(root, "features", `epic-${f + 1}`), createdAt, filler(500, "brief")).lastInsertRowid);
      featureIds.push(fid);
      insBlock.run(fid, "part A", 0, createdAt);
      insBlock.run(fid, "part B", 1, createdAt);
      // 总控：/clear 过一次的链。
      const c0 = `c-${fid}-0`;
      const c1 = `c-${fid}-1`;
      insSession.run(c0, null, join(root, "features", `epic-${f + 1}`), "butler", "总控", now - day, 0, c1, createdAt, null, 1, fid, null, null);
      insSession.run(c1, null, join(root, "features", `epic-${f + 1}`), "butler", "总控", now - 60_000, 0, null, createdAt + 1, null, 1, fid, f % 2 === 0 ? now - 60_000 : null, f % 2 === 0 ? "idle" : null);
      for (let h = 0; h < scale.featureHandoffs; h++) {
        insFeatureHandoff.run(fid, createdAt + h * 3_600_000, JSON.stringify({ summary: filler(2000, `epic ${f} ${h}`), blockers: [], next_steps: [{ ticket: null, text: filler(300, "next") }] }), filler(3000, "raw"));
      }
      for (let t = 0; t < scale.ticketsPerFeature; t++) addTicket(`EP${f + 1}-${t + 1}`, fid, createdAt + t * 60_000, t === 0);
      // 一个等你回答的问题。
      insInbox.run("decision", c1, null, fid, `Epic ${f + 1} 要不要先合？`, JSON.stringify(["合", "等等"]), null, "pending", now - 120_000);
    }
    for (let t = 0; t < scale.looseTickets; t++) addTicket(`LOOSE-${t + 1}`, null, now - (scale.looseTickets - t) * day, t === 0);
    // Shipherd 之外开的 session（ticket_key 为空）：列表不显示，但同一张表。
    for (let i = 0; i < scale.discoveredSessions; i++) {
      insSession.run(`d-${i}`, null, join(root, "elsewhere", `p${i % 40}`), "discovered", `随手问 ${i}`, now - i * 600_000, 0, null, now - i * 600_000, null, 0, null, null, null);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.close();
  }
  return { featureIds, ticketKeys };
}
