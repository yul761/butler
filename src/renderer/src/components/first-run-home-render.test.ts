import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { S, setUiLang } from "../strings";
import { FirstRunHome, FirstRunHomeView, type FirstRunHomeProps } from "./FirstRunHome";

afterEach(() => setUiLang("zh"));

const HAN = /[一-鿿]/;
const noop = (): FirstRunHomeProps => ({ onNewTicket: vi.fn(), onNewFeature: vi.fn(), onNewEpic: vi.fn(), onOpenSettings: vi.fn() });
const render = (p: FirstRunHomeProps = noop()) => renderToStaticMarkup(createElement(FirstRunHome, p));
const text = (html: string) => html.replace(/<[^>]+>/g, " ");

/** 在 FirstRunHomeView 返回的元素树里按 data-testid 找元素（纯视图，没有 hook）。 */
function find(node: ReactNode, testid: string): ReactElement<{ onClick?: () => void }> | null {
  let hit: ReactElement<{ onClick?: () => void }> | null = null;
  Children.forEach(node, (c) => {
    if (hit || !isValidElement(c)) return;
    const props = c.props as { "data-testid"?: string; children?: ReactNode };
    if (props["data-testid"] === testid) hit = c as ReactElement<{ onClick?: () => void }>;
    else hit = find(props.children, testid);
  });
  return hit;
}

describe("first-run home", () => {
  it("offers the three ways to start, each with its own button", () => {
    const html = render();
    expect(html).toContain('data-testid="first-run-home"');
    for (const [id, label] of [["first-run-new-ticket", S.newTicket], ["first-run-new-feature", S.newFeature], ["first-run-new-epic", S.newEpic]] as const) {
      expect(html).toMatch(new RegExp(`data-testid="${id}"[^>]*>[^<]*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
  });

  it("draws the main flow in order", () => {
    const html = render();
    const start = html.indexOf('data-testid="first-run-flow"');
    expect(start).toBeGreaterThan(-1);
    const flow = html.slice(start);
    let at = -1;
    for (const node of S.firstRun.flow) {
      const i = flow.indexOf(node);
      expect(i, node).toBeGreaterThan(at);
      at = i;
    }
    expect(flow).toContain(S.firstRun.flowNote);
  });

  it("says nothing is done outside by default and links to settings", () => {
    const html = render();
    expect(text(html)).toContain(S.firstRun.defaultsOff);
    expect(html).toContain('data-testid="first-run-settings-link"');
    expect(html).toContain(S.firstRun.openFeatureSettings);
  });

  it("reads in both languages", () => {
    setUiLang("en");
    expect(HAN.test(text(render()))).toBe(false);
    setUiLang("zh");
    expect(text(render())).toContain(S.firstRun.title);
  });

  it("calls each callback once from its own button", () => {
    const p = noop();
    const tree = FirstRunHomeView(p);
    for (const [id, cb] of [["first-run-new-ticket", p.onNewTicket], ["first-run-new-feature", p.onNewFeature], ["first-run-new-epic", p.onNewEpic], ["first-run-settings-link", p.onOpenSettings]] as const) {
      const el = find(tree, id);
      expect(el, id).not.toBeNull();
      el!.props.onClick!();
      expect(cb).toHaveBeenCalledTimes(1);
    }
    expect(p.onNewTicket).toHaveBeenCalledTimes(1);
  });
});
