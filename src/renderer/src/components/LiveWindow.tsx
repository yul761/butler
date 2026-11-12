import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ActivityEvent } from "../../../shared/activity";
import type { NowRow, NowTarget, NowView } from "../../../shared/types";
import { api } from "../api";
import { allRows, eventKey, liveMemoryLine, liveNeeds, livePill, liveRows, mergeEvents, rowLabel, wirePath, type Box } from "../now-view";
import { S } from "../strings";

/** 最多摆几张卡片：再多就挤了，剩下的在下面的列表里。 */
const MAX_CARDS = 8;
/** 每张卡片上的工具调用行数。 */
const CARD_LINES = 3;
/** 核心卡片上的记忆读写条数。 */
const MEMORY_LINES = 4;
/** 推过来的事件留多少条（够每张卡片取最近几行）。 */
const PUSHED_LIMIT = 200;
/** 光点在线上走多久（和样式里 live-travel 的时长一样）；减少动态效果时线亮这么久。 */
const SPARK_MS = 1600;

interface Spark {
  id: number;
  sessionId: string;
  kind: "memory-write" | "memory-read";
}

/** 推过来的 activity:event：留最近的一些，记忆读写各放一个光点，过一会儿收走。 */
function usePushedEvents(): { events: ActivityEvent[]; sparks: Spark[]; pulse: number } {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [sparks, setSparks] = useState<Spark[]>([]);
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    let next = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const off = api.onActivityEvent((e) => {
      setEvents((all) => [...all, e].slice(-PUSHED_LIMIT));
      if (e.kind !== "memory-write" && e.kind !== "memory-read") return;
      const spark: Spark = { id: ++next, sessionId: e.sessionId, kind: e.kind };
      setSparks((all) => [...all, spark]);
      setPulse((n) => n + 1);
      const timer = setTimeout(() => {
        timers.delete(timer);
        setSparks((all) => all.filter((x) => x !== spark));
      }, SPARK_MS);
      timers.add(timer);
    });
    return () => {
      off();
      for (const t of timers) clearTimeout(t);
    };
  }, []);
  return { events, sparks, pulse };
}

const boxOf = (el: Element, origin: DOMRect): Box => {
  const r = el.getBoundingClientRect();
  return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
};

/**
 * 「现在」页最上面的实况（BTL-190 第 7 点）：中间是 Butler 核心卡片（在干活的 session 数、最近的记忆读写），
 * 两边是在干活、在等你的 session 的小终端卡片，虚线连到核心；写记忆时蓝色光点从卡片流向核心，读记忆时绿色光点从核心流向卡片。
 * 虚线的形状按卡片和核心的实际位置算（ResizeObserver）；窄窗口里卡片排成网格、核心在最上面，不画线。动画都在样式里。
 */
export function LiveWindow({ view, onOpen }: { view: NowView; onOpen: (t: NowTarget) => void }) {
  const { events, sparks, pulse } = usePushedEvents();
  const rows = liveRows(view);
  // 要你做事的排前面，其余按页面上的顺序。
  const ordered = [...rows.filter((r) => liveNeeds(r) > 0), ...rows.filter((r) => liveNeeds(r) === 0)];
  const cards = ordered.slice(0, MAX_CARDS);
  const ids = cards.map((r) => r.sessionId!).join(",");

  const grid = useRef<HTMLDivElement>(null);
  const core = useRef<HTMLDivElement>(null);
  const cardEls = useRef(new Map<string, HTMLElement>());
  const [wires, setWires] = useState<Record<string, string>>({});
  useLayoutEffect(() => {
    const g = grid.current;
    if (!g || !core.current) return;
    const measure = () => {
      if (!core.current) return;
      const origin = g.getBoundingClientRect();
      const c = boxOf(core.current, origin);
      const next: Record<string, string> = {};
      for (const [id, el] of cardEls.current) next[id] = wirePath(boxOf(el, origin), c);
      setWires((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(g);
    ro.observe(core.current);
    for (const el of cardEls.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [ids]);

  if (rows.length === 0) {
    return (
      <section className="live live-empty" aria-label={S.liveTitle}>
        <h3 className="live-title">{S.liveTitle}</h3>
        <p className="live-empty-text">{S.liveEmpty}</p>
      </section>
    );
  }

  const left = Math.ceil(cards.length / 2);
  const gridRows = Math.max(1, left);
  const memory = mergeEvents(view.memory, events, MEMORY_LINES, (e) => e.kind !== "tool");
  const everyone = allRows(view);
  return (
    <section className="live" aria-label={S.liveTitle}>
      <h3 className="live-title">{S.liveTitle}</h3>
      <div className="live-stage">
        <div className="live-grid" ref={grid}>
          <svg className="live-wires" aria-hidden="true">
            {cards.map((r) => {
              const d = wires[r.sessionId!];
              return d ? <path key={r.sessionId} className={`live-wire${r.working ? " work" : ""}`} d={d} /> : null;
            })}
            {sparks.map((s) => {
              const d = wires[s.sessionId];
              return d ? <path key={s.id} className={`live-spark ${s.kind}`} d={d} pathLength={100} /> : null;
            })}
          </svg>
          <div className="live-core" ref={core} style={{ "--rows": gridRows } as CSSProperties}>
            {pulse > 0 && <span key={pulse} className="live-core-pulse" aria-hidden="true" />}
            <div className="live-core-name">Butler</div>
            <div className="live-core-count">
              <strong>{view.running}</strong>
              <span>{S.liveWorking}</span>
            </div>
            <div className="live-core-memory">
              <h4>{S.liveMemory}</h4>
              {memory.length === 0 && <p className="live-mem none">{S.liveNoMemory}</p>}
              {memory.map((e) => {
                const m = liveMemoryLine(e, everyone, S);
                return (
                  <p key={eventKey(e)} className={`live-mem ${e.kind}`}>
                    {m.who && <span className="who">{m.who}</span>}
                    <span className="verb">{m.verb}</span>
                    <span className="label">{m.label}</span>
                  </p>
                );
              })}
            </div>
            {ordered.length > cards.length && <div className="live-more">{S.liveMore(ordered.length - cards.length)}</div>}
          </div>
          {cards.map((r, n) => (
            <LiveCard
              key={r.sessionId}
              row={r}
              lines={mergeEvents(r.recent, events, CARD_LINES, (e) => e.sessionId === r.sessionId)}
              // 先左后右交替摆，一边一列。
              place={{ "--col": n % 2 === 0 ? 1 : 3, "--row": Math.floor(n / 2) + 1 } as CSSProperties}
              onOpen={onOpen}
              setRef={(el) => {
                if (el) cardEls.current.set(r.sessionId!, el);
                else cardEls.current.delete(r.sessionId!);
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

interface CardProps {
  row: NowRow;
  lines: ActivityEvent[];
  place: CSSProperties;
  onOpen: (t: NowTarget) => void;
  setRef: (el: HTMLElement | null) => void;
}

/** 一个 session 的小终端卡片：ticket 号（总控、修复写它是什么）、仓库、状态药丸、最近 3 行工具调用；在等你时边框变黄，顶上写「需要你 · N」。 */
function LiveCard({ row: r, lines, place, onOpen, setRef }: CardProps) {
  const pill = livePill(r, S);
  const needs = liveNeeds(r);
  return (
    <button ref={setRef} className={`live-card ${pill.tone}${needs > 0 && pill.tone !== "need" ? " need" : ""}`} style={place} title={r.title ?? undefined} onClick={() => onOpen(r.target)}>
      {needs > 0 && <span className="live-badge">{S.liveNeedsYou(needs)}</span>}
      <span className="live-card-head">
        <span className="live-key">{rowLabel(r, S)}</span>
        {r.where && <span className="live-where">{r.where}</span>}
        <span className={`live-pill ${pill.tone}`}>{pill.text}</span>
      </span>
      <span className="live-lines">
        {lines.length === 0 && <span className="live-line none">{S.liveNoTools}</span>}
        {lines.map((e) => (
          <span key={eventKey(e)} className={`live-line ${e.kind}`}>
            {e.kind !== "tool" && <span className="verb">{e.kind === "memory-write" ? S.liveWrote : S.liveRead}</span>}
            {e.label}
          </span>
        ))}
      </span>
    </button>
  );
}
