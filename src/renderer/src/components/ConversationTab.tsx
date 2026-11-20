// 对话 tab（UI 重做第 5 层）：一条时间线——主流对话、黄框（分叉讨论）、换新分隔线，总控对话区还穿插子 session 的汇报。
// 下面的输入框选「发给」开发 session 还是只问不改（开一个分叉讨论）。ticket 页还能「并排显示终端」。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CONV_QUERY_MAX, type ConvMessage } from "../../../shared/conversation";
import type { ForkView } from "../../../shared/fork";
import type { InboxScope } from "../../../shared/types";
import { api, ButlerError } from "../api";
import {
  buildTimeline, draftCheck, keepSelection, lastQuestion, latestOnly, mergeConvPage, mergeReportPage, refusalText, rememberText, sendBlockText, turnBlocks,
  type ConvFilter, type ConvLoaded, type ReportsLoaded, type TimelineItem,
} from "../conversation-view";
import { reportError } from "../errors";
import { resetClock } from "../availability-view";
import { saveConvSplit, savedConvSplit, saveSendTarget, savedSendTarget } from "../local-prefs";
import { S } from "../strings";
import { ForkBox, type ForkActions } from "./ForkBox";
import { ReportBody } from "./InboxPanes";
import { STATE_DEBOUNCE_MS } from "./useStateRefetch";

/** 一页取多少条对话、多少条汇报。 */
const CONV_PAGE = 50;
const REPORT_PAGE = 30;

type Target = "dev" | "fork";
type Pending = ForkActions["pending"][number];

/** 只吃 props 的时间线：同一轮的几条 agent 消息合成一块（turnBlocks）；黄框里的消息不合。 */
export function ConversationFeed(p: { items: TimelineItem[]; hasOlder: boolean; onOlder: () => void; actions: ForkActions; now: number; emptyText?: string }) {
  return (
    <div className="feed">
      {p.hasOlder && <button className="older" onClick={p.onOlder}>{S.conv.older}</button>}
      {p.items.length === 0 && <p className="muted">{p.emptyText ?? S.conv.empty}</p>}
      {turnBlocks(p.items).map((b) => {
        if (b.kind === "turn") return <div key={b.key} className="msg-a">{b.msgs.map((m) => <p key={m.id}>{m.text}</p>)}</div>;
        const it = b.item;
        switch (it.kind) {
          case "msg": return <div key={it.key} className="msg-u">{S.conv.you}{it.msg.text}</div>;
          case "sep": return <div key={it.key} className="sep"><span>{S.conv.refreshSep(resetClock(it.at, p.now))}</span></div>;
          case "fork": return <ForkBox key={it.key} fork={it.fork} actions={p.actions} now={p.now} />;
          case "report": return <div key={it.key} className={`inbox-report ${it.report.reportKind ?? "progress"}`}><ReportBody r={it.report} /></div>;
        }
      })}
    </div>
  );
}

/** 搜索结果：平铺，分叉讨论里的那条带「讨论」标记。还没搜时为 null。 */
export function SearchHits({ hits }: { hits: ConvMessage[] | null }) {
  if (hits === null) return null;
  if (hits.length === 0) return <p className="muted">{S.conv.noMatch}</p>;
  return (
    <div className="feed">
      {hits.map((m) => (
        <div key={m.id} className={m.role === "user" ? "msg-u" : "msg-a"}>
          {m.forkId !== null && <span className="fork-tag">{S.conv.forkTag}</span>}
          {m.role === "user" && S.conv.you}{m.text}
        </div>
      ))}
    </div>
  );
}

export function SendBar(p: {
  target: Target; onTarget: (t: Target) => void; busy: boolean; notice: string | null;
  draft: string; onDraft: (s: string) => void; onSend: () => void;
}) {
  const check = draftCheck(p.target, p.draft);
  return (
    <div className="conv-input">
      <textarea rows={3} value={p.draft} placeholder={S.conv.askPlaceholder} onChange={(e) => p.onDraft(e.target.value)} />
      <div className="conv-target">
        <span className="muted">{S.conv.sendTo}</span>
        <span role="radiogroup" aria-label={S.conv.sendTo}>
          {(["dev", "fork"] as const).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={p.target === t} className={p.target === t ? "active" : undefined} onClick={() => p.onTarget(t)}>
              {t === "dev" ? S.conv.toDev : S.conv.toFork}
            </button>
          ))}
        </span>
        <button className="primary" disabled={p.busy || check.blank || check.over} onClick={p.onSend}>{S.conv.send}</button>
      </div>
      {check.over && <p className="error">{S.conv.tooLong(check.max)}</p>}
      {p.notice && <p className="error conv-notice">{p.notice}</p>}
    </div>
  );
}

/** 设置里的记忆开关（关着时「记进记忆」不能点）；开关一变（memoryChanged(null)）就重读。 */
function useMemoryOn(): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    let live = true;
    const load = () => api.settings().then((s) => live && setOn(s.memoryEnabled !== "0"), reportError);
    load();
    const off = api.onMemoryChanged((k) => {
      if (k === null) load();
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return on;
}

/** IPC 被拒的原因 → 一句话；不是 ButlerError 的照常报到顶上的错误条。 */
function refusal(e: unknown): string {
  if (e instanceof ButlerError) return refusalText(e.code, S);
  reportError(e);
  return refusalText("other", S);
}

const without = <T,>(r: Record<number, T>, id: number): Record<number, T> => Object.fromEntries(Object.entries(r).filter(([k]) => Number(k) !== id));

export function ConversationTab(p: {
  /** 链上任意 id；默认显示的那个 session。 */
  rootSessionId: string;
  /** 多于一个时顶上出切换条（id 用链根）。 */
  sessions: { id: string; label: string }[];
  /** ticket 页传：渲染这个 session 的终端（复用 TicketPage 已有的 TerminalPane 状态）。不传就不出「并排显示终端」。 */
  renderTerminal?: (sessionId: string) => ReactNode;
  /** 总控对话区传：把这个范围的汇报按时间排进来。 */
  reportScope?: InboxScope;
  /** 「并排显示终端」按页面记，这是页面的名字（比如 `ticket:BTL-7`）；不给时用 rootSessionId。 */
  page?: string;
  /** 落点要求换到 rootSessionId 时加一（ticket 页从卡片进来）；其余时候 rootSessionId 变了也不跟着跳。 */
  focusKey?: number;
  /** 放在输入框上面（总控页的 ButlerReplies）。 */
  footer?: ReactNode;
}) {
  // 选中的 session 只在两种时候变：用户点了切换条；或者它从列表里没了（回到默认）。
  // 默认的那个（rootSessionId）按最近活动变了不跟着跳；落点明确要换时由 focusKey 推一次。
  const [selected, setSelected] = useState(p.rootSessionId);
  const sessionIds = p.sessions.map((s) => s.id).join("\n");
  useEffect(() => setSelected((cur) => keepSelection(cur, p.sessions, p.rootSessionId)), [sessionIds]);
  useEffect(() => {
    if (p.focusKey !== undefined) setSelected(p.rootSessionId);
  }, [p.focusKey]);
  const scope = p.reportScope ?? null;
  const scopeKey = scope ? JSON.stringify(scope) : null;

  const [conv, setConv] = useState<ConvLoaded | null>(null);
  const [forks, setForks] = useState<ForkView[]>([]);
  const [reports, setReports] = useState<ReportsLoaded | null>(null);
  const [filter, setFilter] = useState<ConvFilter>("all");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ConvMessage[] | null>(null);
  const splitPage = p.page ?? p.rootSessionId;
  const [split, setSplit] = useState(() => savedConvSplit(splitPage));
  const [target, setTarget] = useState<Target>(savedSendTarget);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<ForkActions["pending"]>({});
  const pendingRef = useRef(pending);
  const [forkNotice, setForkNotice] = useState<ForkActions["notice"]>({});
  const memorySetting = useMemoryOn();
  /** 这个范围记不了（remember 回了 disabled：记忆关着，或者没有 ticket / feature 可记）。 */
  const [memoryRefused, setMemoryRefused] = useState(false);
  // 设置里重新打开了记忆：之前回过 disabled 的也再给一次机会。
  useEffect(() => {
    if (memorySetting) setMemoryRefused(false);
  }, [memorySetting]);
  /** 搜索只认最后一次：先发的晚回来不覆盖后发的。 */
  const searchSeq = useRef(latestOnly());

  /** 每切一次 session 加一：旧 session 的回包不再写进来。 */
  const gen = useRef(0);
  /** 当前显示的链根：取自消息，还没有消息时取自分叉列表；推送事件带的是链根，拿它比。 */
  const root = conv?.messages[0]?.rootSessionId ?? forks[0]?.rootSessionId ?? null;
  const rootRef = useRef(root);
  rootRef.current = root;
  /** 重取最新一页对话和分叉列表（动作做完、发出去以后也调它）。 */
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    const g = ++gen.current;
    const live = () => gen.current === g;
    setConv(null);
    setForks([]);
    setReports(null);
    setHits(null);
    pendingRef.current = {};
    setPending({});
    setForkNotice({});
    setNotice(null);
    setMemoryRefused(false);
    const latest = () => {
      api.convList(selected, { limit: CONV_PAGE }).then((pg) => live() && setConv((c) => mergeConvPage(c, pg, false)), reportError);
      api.forkList(selected).then((fs) => live() && setForks(fs), reportError);
    };
    const latestReports = () => {
      if (!scope) return;
      api.inboxReports(scope, { limit: REPORT_PAGE }).then((pg) => live() && setReports((r) => mergeReportPage(r, pg, false)), (e) => {
        // 汇报取不到：报错，但对话照常显示（当作没有汇报）。
        reportError(e);
        if (live()) setReports((r) => r ?? { reports: [], hasMore: false });
      });
    };
    refreshRef.current = latest;
    latest();
    latestReports();
    // hook 事件一来一串：合并成一次重取（同 useStateRefetch 的防抖）。
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reportTimer: ReturnType<typeof setTimeout> | null = null;
    const onRoot = (r: string) => {
      if (r !== rootRef.current && r !== selected) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(latest, STATE_DEBOUNCE_MS);
    };
    const offs = [api.onConvAppended(onRoot), api.onForkChanged(onRoot)];
    if (scope) {
      offs.push(api.onStateChanged(() => {
        if (reportTimer) clearTimeout(reportTimer);
        reportTimer = setTimeout(latestReports, STATE_DEBOUNCE_MS);
      }));
    }
    return () => {
      gen.current++;
      if (timer) clearTimeout(timer);
      if (reportTimer) clearTimeout(reportTimer);
      for (const off of offs) off();
    };
  }, [selected, scopeKey]);

  // 第一次载入这个 session 的对话：滚到最新的那条。
  const end = useRef<HTMLDivElement>(null);
  const loaded = conv !== null;
  useEffect(() => {
    if (loaded) end.current?.scrollIntoView({ block: "end" });
  }, [loaded, selected]);

  function loadOlder() {
    const g = gen.current;
    if (conv?.hasMore && conv.messages.length > 0) {
      api.convList(selected, { before: conv.messages[0].id, limit: CONV_PAGE }).then((pg) => gen.current === g && setConv((c) => mergeConvPage(c, pg, true)), reportError);
    }
    if (scope && reports?.hasMore && reports.reports.length > 0) {
      api.inboxReports(scope, { before: reports.reports[0].id, limit: REPORT_PAGE }).then((pg) => gen.current === g && setReports((r) => mergeReportPage(r, pg, true)), reportError);
    }
  }

  function search(q: string) {
    const g = gen.current;
    const latest = searchSeq.current();
    if (!q.trim()) return setHits(null);
    api.convSearch(selected, q.trim()).then((h) => gen.current === g && latest() && setHits(h), reportError);
  }

  /** 一个黄框的动作：先占上 pending（连点只发一次），做完清掉；结果或原因写进这个框。没抛错为 true。 */
  async function act(id: number, kind: NonNullable<Pending>, run: () => Promise<string | null>): Promise<boolean> {
    if (pendingRef.current[id]) return false;
    const g = gen.current;
    pendingRef.current = { ...pendingRef.current, [id]: kind };
    setPending(pendingRef.current);
    setForkNotice((n) => without(n, id));
    let text: string | null;
    let ok = true;
    try {
      text = await run();
    } catch (e) {
      ok = false;
      text = refusal(e);
    } finally {
      if (gen.current === g) {
        pendingRef.current = without(pendingRef.current, id);
        setPending(pendingRef.current);
        refreshRef.current();
      }
    }
    if (gen.current === g && text !== null) setForkNotice((n) => ({ ...n, [id]: text }));
    return ok;
  }

  const actions: ForkActions = {
    pending,
    notice: forkNotice,
    memoryOn: memorySetting && !memoryRefused,
    followUp: (id, q) => act(id, "ask", async () => {
      await api.forkAsk(selected, id, q);
      return null;
    }),
    sendConclusion: (id) => void act(id, "send", async () => {
      const r = await api.forkSendConclusion(id);
      if (!r.ok) return sendBlockText(r.reason, S);
      // 「已发给 session · 时间」由框里的 summarySentAt 显示；分叉列表重取回来之前先写上。
      setForks((fs) => fs.map((f) => (f.id === id ? { ...f, summarySentAt: r.at } : f)));
      return null;
    }),
    remember: (id) => void act(id, "remember", async () => {
      const { result } = await api.forkRemember(id);
      if (result === "disabled") setMemoryRefused(true);
      return rememberText(result, S);
    }),
    reaskFull: (id) => void act(id, "reask", async () => {
      await api.forkReaskFull(id);
      return null;
    }),
    retry: (id) => {
      const f = forks.find((x) => x.id === id);
      const q = f ? lastQuestion(f) : null;
      if (!f || q === null) return;
      // 没分叉出来的讨论不能接着问：重新开一个，问同一句。
      const into = f.error?.code === "not_forked" ? null : id;
      void act(id, "ask", async () => {
        await api.forkAsk(selected, into, q);
        return null;
      });
    },
  };

  async function send() {
    const check = draftCheck(target, draft);
    if (busy || check.blank || check.over) return;
    const g = gen.current;
    setBusy(true);
    setNotice(null);
    try {
      if (target === "dev") {
        // 这句话由第 4 层从 transcript 记进对话，自己会出现；被挡下时草稿留着。
        const r = await api.convSend(selected, draft);
        // 发出去了就清草稿，不管这期间切没切 session（草稿是整个 tab 共用的）。
        if (r.ok) setDraft("");
        else if (gen.current === g) setNotice(sendBlockText(r.reason, S));
      } else {
        // 同一句还在答时主进程返回已有的 forkId：黄框按分叉列表画，不会多出一个。
        await api.forkAsk(selected, null, draft.trim());
        if (gen.current !== g) return;
        setDraft("");
        refreshRef.current();
      }
    } catch (e) {
      if (gen.current === g) setNotice(refusal(e));
    } finally {
      setBusy(false);
    }
  }

  const pickTarget = (t: Target) => {
    setTarget(t);
    saveSendTarget(t);
  };
  const toggleSplit = () => {
    setSplit(!split);
    saveConvSplit(splitPage, !split);
  };

  const now = Date.now();
  const ready = conv !== null && (scope === null || reports !== null);
  const items = ready
    ? buildTimeline({
      messages: conv.messages, refreshMarks: conv.refreshMarks, convHasMore: conv.hasMore, forks,
      reports: reports?.reports ?? [], reportsHasMore: reports?.hasMore ?? false, filter: filter === "forks" ? "forks" : "all",
    })
    : [];
  const hasOlder = filter === "all" && (!!conv?.hasMore || !!reports?.hasMore);
  const filters: [ConvFilter, string][] = [["all", S.conv.filterAll], ["forks", S.conv.filterForks], ["search", S.conv.filterSearch]];

  const body = (
    <div className="conv">
      {p.sessions.length > 1 && (
        <div className="conv-switch">
          {p.sessions.map((s) => (
            <button key={s.id} className={s.id === selected ? "active" : undefined} aria-pressed={s.id === selected} onClick={() => setSelected(s.id)}>{s.label}</button>
          ))}
        </div>
      )}
      <div className="tools">
        {filters.map(([f, label]) => (
          <button key={f} className={f === filter ? "active" : undefined} aria-pressed={f === filter} onClick={() => setFilter(f)}>{label}</button>
        ))}
        {p.renderTerminal && <button className="conv-side" onClick={toggleSplit}>{split ? S.conv.hideTerminal : S.conv.sideTerminal}</button>}
      </div>
      {filter === "search" ? (
        <>
          <form className="conv-search" onSubmit={(e) => { e.preventDefault(); search(query); }}>
            <input type="search" value={query} maxLength={CONV_QUERY_MAX} placeholder={S.conv.searchPlaceholder} onChange={(e) => setQuery(e.target.value)} />
          </form>
          <SearchHits hits={hits} />
        </>
      ) : (
        ready && <ConversationFeed items={items} hasOlder={hasOlder} onOlder={loadOlder} actions={actions} now={now} emptyText={scope ? S.lay.ctlEmpty : undefined} />
      )}
      <div ref={end} />
      {p.footer}
      <SendBar target={target} onTarget={pickTarget} busy={busy} notice={notice} draft={draft} onDraft={setDraft} onSend={() => void send()} />
    </div>
  );
  if (!p.renderTerminal || !split) return body;
  return (
    <div className="conv-split">
      <div className="conv-term">{p.renderTerminal(selected)}</div>
      {body}
    </div>
  );
}
