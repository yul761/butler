import { afterEach, describe, expect, it } from "vitest";
import type { PrivacyLevel } from "../../shared/llm";
import { NARRATIVE_SYSTEM_PROMPT } from "./narrative";
import { chatReply, gatewayHarness, sampleSource, seededRng, type FakeRequest, type GatewayHarness } from "./testing";
import type { NarrativeSource, OutboundPayload, Rng } from "./types";

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const SURNAMES = ["王", "李", "张", "刘", "陈", "杨", "黄", "赵", "吴", "周"];
const GIVEN = ["晓", "明", "婷", "伟", "芳", "磊", "静", "军", "敏", "超", "霞", "斌", "琳", "浩"];
const CODENAMES = ["天穹", "赤霄", "青鸾", "玄武", "白泽", "朱雀"];
const LATIN = ["Alice", "Bob", "Carol", "Dmitri", "Erin", "Farah"];
const STATUSES = ["active", "in_review", "blocked", "merged_pending_followup"] as const;

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[rng(xs.length)];
const word = (rng: Rng, n: number, letters = LOWER) => Array.from({ length: n }, () => letters[rng(letters.length)]).join("");
const digits = (rng: Rng, n: number) => Array.from({ length: n }, () => String(rng(10))).join("");
/** ASCII → 全角（NFKC 会变回来）。 */
const fullWidth = (s: string) => s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));

const ZWSP = "\u200b";
/** 在字符串中间插入零宽空格（登记的仍是干净写法，文本里是变体）。 */
const zw = (rng: Rng, s: string) => {
  const cs = [...s];
  const i = 1 + rng(cs.length - 1);
  return cs.slice(0, i).join("") + ZWSP + cs.slice(i).join("");
};
/** ticket 的变体写法：原样、零宽空格、U+2011 非断行连字符、en dash。 */
const ticketVariant = (rng: Rng, t: string) => {
  switch (rng(4)) {
    case 0: return t;
    case 1: return zw(rng, t);
    case 2: return t.replace("-", "\u2011");
    default: return t.replace("-", "\u2013");
  }
};
const personVariant = (rng: Rng, p: string) => (rng(2) ? zw(rng, p) : p);

interface World {
  tickets: string[];
  repos: string[];
  branches: string[];
  people: string[];
  terms: string[];
}

function world(rng: Rng): World {
  const tickets = new Set<string>();
  const want = 3 + rng(3);
  while (tickets.size < want) tickets.add(`${word(rng, 2 + rng(3), UPPER)}-${1 + rng(9)}${digits(rng, rng(4))}`);
  const keys = [...tickets];
  return {
    tickets: keys,
    repos: [`${word(rng, 4)}-${word(rng, 5)}${digits(rng, 2)}`, `${word(rng, 6)}${digits(rng, 3)}`],
    branches: keys.map((k) => `feature/${k}-${word(rng, 5)}`),
    people: [`${pick(rng, SURNAMES)}${pick(rng, GIVEN)}${pick(rng, GIVEN)}`, `${pick(rng, LATIN)} ${word(rng, 1, UPPER)}${word(rng, 5)}`],
    terms: [`${pick(rng, CODENAMES)}${pick(rng, GIVEN)}计划`, `Project ${word(rng, 1, UPPER)}${word(rng, 6)}`],
  };
}

/** 中文自由文本模板：原值和中文粘在一起，夹杂小写、大写和全角写法。 */
const tk = (w: World, r: Rng) => ticketVariant(r, pick(r, w.tickets));
const pp = (w: World, r: Rng) => personVariant(r, pick(r, w.people));
const TEMPLATES: ((w: World, r: Rng) => string)[] = [
  (w, r) => `修好${tk(w, r)}的登录问题，然后通知${pp(w, r)}`,
  (w, r) => `等${pp(w, r)}review ${tk(w, r).toLowerCase()} 的 PR`,
  (w, r) => `把 ${pick(r, w.branches)} rebase 到 main，再部署${pick(r, w.repos)}`,
  (w, r) => `${pick(r, w.terms)}需要${fullWidth(tk(w, r))}先合并`,
  (w, r) => `和${pp(w, r).toUpperCase()}确认${pick(r, w.repos).toUpperCase()}的配置`,
  (w, r) => `${pick(r, w.terms).toLowerCase()} 的灰度开关，见${pick(r, w.branches)}`,
];

function source(w: World, rng: Rng): NarrativeSource {
  const text = () => pick(rng, TEMPLATES)(w, rng);
  return {
    date: "2026-10-21",
    tickets: w.tickets.map((key, i) => ({
      key,
      status: pick(rng, STATUSES),
      pr: i % 2 ? { state: "open", review: "approved" } : null,
      daysInStatus: rng(10),
      idleDays: rng(10),
      doneLastDay: rng(4),
      nextSteps: [text(), text()],
      blockers: [text()],
      followups: [{ kind: "config", trigger: "after_merge", description: text(), overdueDays: null }],
    })),
    items: w.tickets.map((key) => ({ section: "today", rule: "next_step", ticketKey: key, days: null, count: null })),
    known: { tickets: w.tickets, repos: w.repos, branches: w.branches },
  };
}

/** 请求体里除系统提示以外的全部内容（NFKC + 小写，和原值比较时也同样处理）。 */
function outboundWithoutSystemPrompt(body: string): string {
  const parsed = JSON.parse(body) as { messages: { role: string; content: string }[] } & Record<string, unknown>;
  const system = parsed.messages.filter((m) => m.role === "system");
  expect(system.map((m) => m.content)).toEqual([NARRATIVE_SYSTEM_PROMPT]);
  const rest = { ...parsed, messages: parsed.messages.filter((m) => m.role !== "system") };
  return JSON.stringify(rest).normalize("NFKC").toLowerCase();
}

/**
 * Oracle independent of the code under test: do NOT use normalizeText here.
 * If it shared the pipeline's normalisation, a bug there (e.g. no dash folding) would hide the very leak it causes.
 */
const canon = (s: string) =>
  s.normalize("NFKC").replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").replace(/[\p{Pd}\u2212]/gu, "-").replace(/\s+/g, " ").toLowerCase();

function leaked(body: string, w: World): string[] {
  const out = canon(outboundWithoutSystemPrompt(body));
  return [...w.tickets, ...w.repos, ...w.branches, ...w.people, ...w.terms].filter((v) => out.includes(canon(v)));
}

/** 服务商原样引用第一个 ticket 的占位符：用来确认本地能还原。 */
function echoFirstTicket(r: FakeRequest) {
  const payload = JSON.parse((JSON.parse(r.body) as { messages: { content: string }[] }).messages[1].content) as OutboundPayload;
  return chatReply(JSON.stringify({ focus: [`先处理 ${payload.tickets[0].id} 的事。`] }));
}

let h: GatewayHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe("privacy invariant (release blocker, design §11)", () => {
  for (const level of ["metadata", "redacted"] as const satisfies readonly PrivacyLevel[]) {
    it(`no original ticket key, repo, branch, person or sensitive term leaves the machine at the ${level} level`, async () => {
      for (let seed = 1; seed <= 40; seed++) {
        const rng = seededRng(seed * 7919);
        const w = world(rng);
        h = await gatewayHarness({ level, rng: seededRng(seed) });
        h.terms.replaceAll([...w.people.map((term) => ({ term, category: "person" as const })), ...w.terms.map((term) => ({ term, category: "term" as const }))]);
        h.provider.handle(echoFirstTicket);
        const r = await h.gateway.narrate(source(w, rng));
        expect(r.status, `seed ${seed}`).toBe("ok");
        expect(h.bodies(), `seed ${seed}`).toHaveLength(1);
        expect(leaked(h.bodies()[0], w), `seed ${seed}`).toEqual([]);
        // 本地还原：narrative 里是真实的 ticket 号。
        expect(w.tickets.map((t) => `先处理 ${t} 的事。`), `seed ${seed}`).toContain(r.narrative);
        expect(r.narrative, `seed ${seed}`).not.toContain("[[");
        await h.close();
        h = null;
      }
    }, 120_000);
  }

  it("gives the same ticket a different placeholder in every request", async () => {
    h = await gatewayHarness({ rng: seededRng(99) });
    expect((await h.gateway.narrate(sampleSource())).status).toBe("ok");
    expect((await h.gateway.narrate(sampleSource())).status).toBe("ok");
    const ids = h.bodies().map((b) =>
      (JSON.parse((JSON.parse(b) as { messages: { content: string }[] }).messages[1].content) as OutboundPayload).tickets.map((t) => t.id),
    );
    expect(ids).toHaveLength(2);
    expect(ids[0].filter((id) => ids[1].includes(id))).toEqual([]);
  });

  it("an unknown ticket key, a URL or a secret in free text blocks the request where free text is sent, and nothing leaves", async () => {
    const cases: [PrivacyLevel, string, string][] = [
      ["redacted", "等 ZZTOP-9 合并", "blocked"],
      ["redacted", "部署前问一下 ops@example.com", "blocked"],
      ["redacted", "token=AbCdEf123456", "blocked"],
      // 超过 120 字符：密钥、邮箱在截断处被切断，只有截断前的扫描能拦住。
      ["redacted", "好".repeat(112) + " token=AbCdEf123456", "blocked"],
      ["redacted", "好".repeat(103) + " wang.lei@acme-corp.com", "blocked"],
      ["full", "token=AbCdEf123456", "blocked"],
      ["full", "看 https://wiki.corp/x", "blocked"],
      // metadata 不发自由文本：同样的内容根本不会出现在请求里。
      ["metadata", "token=AbCdEf123456", "ok"],
    ];
    for (const [level, text, expected] of cases) {
      h = await gatewayHarness({ level });
      const src = sampleSource();
      src.tickets[0].nextSteps = [text];
      expect((await h.gateway.narrate(src)).status, `${level}: ${text}`).toBe(expected);
      for (const body of h.bodies()) expect(body, `${level}: ${text}`).not.toContain(text);
      if (expected === "blocked") expect(h.bodies(), `${level}: ${text}`).toHaveLength(0);
      await h.close();
      h = null;
    }
  });
});