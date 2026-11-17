import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrStageCell, PrStageId, PrStagesTicket, PrStagesView } from "../../../shared/pr-stages";
import { S } from "../strings";
import { EpicPrRows, FeaturePrRows, TicketPrRows } from "./PrStages";

const IDS: PrStageId[] = ["design", "dev", "self_review", "ci", "peer_review", "merge"];
const stages: PrStageCell[] = IDS.map((id) => ({ id, state: "done", round: 1, at: null }));

const prRow = (n: number, over: Partial<PrStagesView> = {}): PrStagesView => ({
  ticketKey: "T-1", featureId: null, repoId: 1, repoName: "web", prId: n, slug: null, noPr: false,
  prNumber: n, prUrl: `https://github.com/acme/web/pull/${n}`, closed: false, stages, timeline: [], ...over,
});
const noPrRow: PrStagesView = { ...prRow(0), prId: null, noPr: true, prNumber: null, prUrl: null };

const render = (rows: PrStagesView[]): string => renderToStaticMarkup(createElement(TicketPrRows, { rows }));

describe("the ticket tab's PR rows", () => {
  // 时间线的收起状态读 localStorage：给个空的，免得 Node 报 ExperimentalWarning。
  beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null }));
  afterEach(() => vi.unstubAllGlobals());

  it("the ticket tab renders three PR rows newest first with clickable numbers", () => {
    const html = render([prRow(3), prRow(2), prRow(1)]);
    const links = [...html.matchAll(/<button class="pr-link link"[^>]*>(#\d+)<\/button>/g)].map((m) => m[1]);
    expect(links).toEqual(["#3", "#2", "#1"]);
    expect(html.match(/class="pr-repo"/g)).toHaveLength(3);
    // 阶段名写在每一格上。
    expect(html).toContain(S.prStage.self_review);
  });

  it("a slug-only PR shows its slug", () => {
    // 单独一行时也写 slug（不是 ticket 仓库的 PR）。
    const html = render([prRow(7, { repoId: null, repoName: "other/lib", slug: "other/lib", prUrl: "https://github.com/other/lib/pull/7" })]);
    expect(html).toContain('<span class="pr-repo-name">other/lib</span>');
    expect(html).toContain("#7");
  });

  it("the no-PR row says so", () => {
    const html = render([noPrRow, prRow(1)]);
    expect(html).toContain(S.prNoPrYet);
    expect(html.indexOf(S.prNoPrYet)).toBeLessThan(html.indexOf("#1"));
    expect(html.match(/class="pr-link link"/g)).toHaveLength(1);
  });
});

const ticket = (key: string, rows: PrStagesView[], o: Partial<PrStagesTicket> = {}): PrStagesTicket =>
  ({ ticketKey: key, featureId: 1, title: null, archived: false, merged: false, hasRepos: true, rows, ...o });
const renderFeature = (tickets: PrStagesTicket[]): string => renderToStaticMarkup(createElement(FeaturePrRows, { tickets, onOpenTicket: () => {} }));
const renderEpic = (tickets: PrStagesTicket[], features: { id: number; name: string }[]): string =>
  renderToStaticMarkup(createElement(EpicPrRows, { tickets, features, onOpenTicket: () => {} }));

describe("the feature and epic PR tables", () => {
  it("a feature with no tickets does not say 还没有仓库", () => {
    const html = renderFeature([]);
    expect(html).toContain(S.prNoTickets);
    expect(html).not.toContain(S.prNoRepos);
  });

  it("archived tickets show the tag", () => {
    const html = renderFeature([ticket("T-1", [prRow(1)], { archived: true }), ticket("T-2", [prRow(2, { ticketKey: "T-2" })])]);
    expect(html.match(new RegExp(S.prArchived, "g"))).toHaveLength(1);
    expect(html.indexOf(S.prArchived)).toBeLessThan(html.indexOf("T-2"));
  });

  it("one row per ticket, with the PR count when there are several, and a note for a ticket with no repos", () => {
    const html = renderFeature([ticket("T-1", [noPrRow, prRow(3), prRow(2)]), ticket("T-2", [prRow(4, { ticketKey: "T-2" })]), ticket("T-3", [], { hasRepos: false })]);
    expect(html.match(/<tr class="clickable"/g)).toHaveLength(3);
    expect(html.match(new RegExp(S.prCount(2), "g"))).toHaveLength(1);
    expect(html).not.toContain(S.prCount(1));
    expect(html).toContain(S.prTicketNoRepos);
  });

  it("an epic feature with no tickets says so instead of 0/0", () => {
    const html = renderEpic([ticket("T-1", [prRow(1)], { merged: true })], [{ id: 1, name: "pay" }, { id: 2, name: "ship" }]);
    expect(html).toContain(S.prMergedOf(1, 1));
    expect(html).toContain(S.prNoTickets);
    expect(html).not.toContain(S.prMergedOf(0, 0));
  });
});
