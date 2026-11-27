// 接上 live store 的页面入口（BTL-277）：App 不再拿着列表往下传，每个入口只订自己用的那一块。
// 页面本身还是按 props 画（render 测试照旧），这里只负责从 store 里挑数据。
import type { ComponentProps } from "react";
import type { FeatureView, TicketView } from "../../../shared/types";
import { isNoWork } from "../home-view";
import { selectAllTickets, selectLiveTickets, selectNameCtx, useLive, type LiveState } from "../live-store";
import { AllWorkPage } from "./AllWorkPage";
import { FeaturePage } from "./FeaturePage";
import { HomePage } from "./HomePage";
import { NewTicketDialog } from "./NewTicketDialog";
import { Sidebar, type SidebarFeature, type SidebarTicket } from "./Sidebar";
import { useNow } from "./TicketActivity";
import { TicketPage } from "./TicketPage";
import { UnclaimedPage } from "./UnclaimedPage";

const ticketName = (t: TicketView): SidebarTicket => ({ key: t.key, title: t.title });
/** 名字的投影：只有名字、增删变了才是新的（useLive 按内容留旧引用）。 */
const selectNames = (s: LiveState): { features: SidebarFeature[]; tickets: SidebarTicket[] } => ({
  features: s.features.map((f) => ({ id: f.id, name: f.name, tickets: f.tickets.map(ticketName) })),
  tickets: s.tickets.map(ticketName),
});

export function LiveSidebar(p: Omit<ComponentProps<typeof Sidebar>, "tickets" | "features">) {
  const names = useLive(selectNames);
  return <Sidebar {...p} tickets={names.tickets} features={names.features} />;
}

type HomeProps = ComponentProps<typeof HomePage>;

export function LiveHomePage(p: Omit<HomeProps, "ctx" | "nowView" | "liveTickets" | "noWork">) {
  const ctx = useLive(selectNameCtx);
  const nowView = useLive((s) => s.nowView);
  const liveTickets = useLive(selectLiveTickets);
  const workCount = useLive((s) => selectAllTickets(s).length + s.features.length);
  const noticeCount = useLive((s) => s.nowView?.notices.length ?? 0);
  const noWork = isNoWork(workCount, p.state.board?.items ?? null, noticeCount);
  return <HomePage {...p} ctx={ctx} nowView={nowView} liveTickets={liveTickets} noWork={noWork} />;
}

export function LiveTicketRoute({ ticketKey, ...p }: Omit<ComponentProps<typeof TicketPage>, "ticket" | "feature"> & { ticketKey: string }) {
  const ticket = useLive((s) => selectAllTickets(s).find((t) => t.key === ticketKey) ?? null, [ticketKey]);
  const featureId = ticket?.featureId ?? null;
  const feature = useLive((s): FeatureView | null => (featureId === null ? null : (s.features.find((f) => f.id === featureId) ?? null)), [featureId]);
  if (!ticket) return null;
  return <TicketPage {...p} ticket={ticket} feature={feature} />;
}

export function LiveFeatureRoute({ featureId, ...p }: Omit<ComponentProps<typeof FeaturePage>, "feature" | "ctx"> & { featureId: number }) {
  const feature = useLive((s) => s.features.find((f) => f.id === featureId) ?? null, [featureId]);
  const ctx = useLive(selectNameCtx);
  if (!feature) return null;
  return <FeaturePage {...p} feature={feature} ctx={ctx} />;
}

export function LiveAllWorkPage(p: Omit<ComponentProps<typeof AllWorkPage>, "features" | "tickets" | "unclaimedCount" | "now">) {
  const names = useLive(selectNames);
  const unclaimedCount = useLive((s) => s.unclaimedCount);
  // 定时走：这一页不再跟着 App 每次刷新重画（BTL-277）。
  const now = useNow();
  return <AllWorkPage {...p} features={names.features} tickets={names.tickets} unclaimedCount={unclaimedCount} now={now} />;
}

export function LiveUnclaimedPage() {
  const tickets = useLive(selectAllTickets);
  return <UnclaimedPage tickets={tickets} />;
}

export function LiveNewTicketDialog(p: Omit<ComponentProps<typeof NewTicketDialog>, "contextTickets">) {
  const tickets = useLive(selectAllTickets);
  return <NewTicketDialog {...p} contextTickets={tickets} />;
}
