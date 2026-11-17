import { useEffect, useState } from "react";
import type { Lesson, LessonAction, LessonRepoView, LessonsState } from "../../../shared/lessons";
import { api } from "../api";
import { reportError } from "../errors";
import { lessonsFor, lessonsTree, pruneLessonsUi, type LessonsSelection } from "../lessons-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

const formatTime = (ms: number) => new Date(ms).toLocaleString([], { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 只有界面状态放在这里；数据都等 stateChanged 之后重取。 */
export function LessonsPage() {
  const state = useStateRefetch("lessons", api.lessonsState);
  const [sel, setSel] = useState<LessonsSelection | null>(null);
  /** 失败原因，按"那一条"的键存：lesson-<id>、repo-<slug>、product-<id>、new-product、suggest-<i>。 */
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** 正在编辑的规矩：mode 决定保存时是只编辑，还是编辑后确认。 */
  const [editing, setEditing] = useState<{ id: number; mode: "edit" | "confirm"; text: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const [merging, setMerging] = useState<{ keepId: number; dropId: number; text: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [newSlugs, setNewSlugs] = useState<string[]>([]);

  /** 换选中项：编辑、合并、勾选、待确认的删除都不带过去。 */
  const select = (next: LessonsSelection) => {
    setSel(next);
    setEditing(null);
    setMerging(null);
    setChecked([]);
    setConfirmingDelete(null);
  };

  // 数据刷新后，指向已经不存在的规矩或产品的界面状态要丢掉（产品 id 会被 SQLite 复用）。
  useEffect(() => {
    if (!state) return;
    const next = pruneLessonsUi(state, { editing, merging, checked, confirmingDelete, sel });
    if (next.editing !== editing) setEditing(next.editing);
    if (next.merging !== merging) setMerging(next.merging);
    if (next.checked.length !== checked.length) setChecked(next.checked);
    if (next.confirmingDelete !== confirmingDelete) setConfirmingDelete(next.confirmingDelete);
    if (next.sel !== sel) setSel(next.sel);
  }, [state]);

  /** 发一个操作；失败时把原因记在 key 下。成功后什么都不补：等 stateChanged。 */
  const act = async (key: string, a: LessonAction): Promise<boolean> => {
    try {
      const r = await api.lessonsAct(a);
      if (r.ok) setConfirmingDelete(null);
      setErrors((e) => {
        const next = { ...e };
        if (r.ok) delete next[key];
        else next[key] = S.lessonsError[r.reason] ?? S.lessonsErrorGeneric;
        return next;
      });
      return r.ok;
    } catch (e) {
      reportError(e);
      return false;
    }
  };
  const err = (key: string) => errors[key] && <p className="error lessons-error" role="alert">{errors[key]}</p>;

  if (!state) return <div className="page lessons-page" />;
  const s: LessonsState = state;
  const noRepos = s.repos.length === 0 && s.products.length === 0 && s.unknownRepos.length === 0;
  const repoBySlug = new Map(s.repos.map((r) => [r.slug, r]));
  const seenRepo = new Set<string>();

  const sources = (l: Lesson) =>
    l.sources.length > 0 && (
      <span className="lesson-sources">
        {l.sources.map((src) => (
          <button key={src.id} className="link lesson-source" data-testid={`lesson-source-${src.id}`} onClick={() => void act(`lesson-${l.id}`, { op: "openSource", sourceId: src.id })}>
            #{src.prNumber}
          </button>
        ))}
      </span>
    );

  const repoRow = (r: LessonRepoView, productId: number | null) => {
    const first = !seenRepo.has(r.slug);
    seenRepo.add(r.slug);
    const suffix = first ? r.slug : `${productId ?? "x"}-${r.slug}`;
    // 产品下的成员行各用自己的键，不然同一个仓库在几个产品下会共用错误和 React 键。
    const key = productId === null ? `repo-${r.slug}` : `product-${productId}-repo-${r.slug}`;
    return (
      <li key={key} className={`lessons-repo${sel?.kind === "repo" && sel.slug === r.slug ? " selected" : ""}`}>
        <div className="lessons-row">
          <button className="lessons-select" data-testid={`lessons-repo-${suffix}`} onClick={() => select({ kind: "repo", slug: r.slug })}>{r.slug}</button>
          <span className="muted">{r.lastAnalyzedAt === null ? S.lessonsNever : S.lessonsLastAnalyzed(formatTime(r.lastAnalyzedAt))}</span>
          <span className="muted">{S.lessonsCounts(r.analyzedCount, r.queued, r.failed)}</span>
          <button
            data-testid={`lessons-backfill-${suffix}`}
            disabled={!s.ghAvailable}
            title={s.ghAvailable ? undefined : S.lessonsNoGh}
            onClick={() => void act(key, { op: "backfill", slug: r.slug })}
          >
            {S.lessonsBackfill}
          </button>
          {productId !== null && (
            <button data-testid={`lessons-remove-${productId}-${r.slug}`} onClick={() => void act(key, { op: "removeFromProduct", id: productId, slug: r.slug })}>{S.lessonsRemoveRepo}</button>
          )}
        </div>
        {r.overflow > 0 && <p className="muted lessons-overflow">{S.lessonsOverflow(r.overflow)}</p>}
        {err(key)}
      </li>
    );
  };

  const productBlock = (g: ReturnType<typeof lessonsTree>[number]) => {
    const p = g.product;
    if (!p) return <ul key="loose" className="lessons-repos">{g.slugs.map((slug) => repoBySlug.get(slug)).filter((r): r is LessonRepoView => !!r).map((r) => repoRow(r, null))}</ul>;
    const key = `product-${p.id}`;
    const deleting = confirmingDelete === key;
    const addable = s.repos.filter((r) => !p.slugs.includes(r.slug));
    const ownCount = s.lessons.filter((l) => l.scope.kind === "product" && l.scope.productId === p.id).length;
    return (
      <div key={key} className="lessons-product">
        <div className="lessons-row">
          <button className={`lessons-select lessons-product-name${sel?.kind === "product" && sel.id === p.id ? " selected" : ""}`} data-testid={`lessons-product-${p.id}`} onClick={() => select({ kind: "product", id: p.id })}>
            {p.name}
          </button>
          <select
            aria-label={S.lessonsAddRepo}
            data-testid={`lessons-add-repo-${p.id}`}
            value=""
            onChange={(e) => e.target.value && void act(key, { op: "addToProduct", id: p.id, slug: e.target.value })}
          >
            <option value="">{S.lessonsAddRepo}</option>
            {addable.map((r) => <option key={r.slug} value={r.slug}>{r.slug}</option>)}
          </select>
          <button
            className={deleting ? "danger" : undefined}
            data-testid={`lessons-delete-product-${p.id}`}
            onClick={() => {
              if (!deleting) return setConfirmingDelete(key);
              setConfirmingDelete(null);
              void act(key, { op: "deleteProduct", id: p.id });
            }}
          >
            {deleting ? S.lessonsDeleteProduct(ownCount) : S.lessonsDelete}
          </button>
        </div>
        {err(key)}
        <ul className="lessons-repos indented">{g.slugs.map((slug) => repoBySlug.get(slug)).filter((r): r is LessonRepoView => !!r).map((r) => repoRow(r, p.id))}</ul>
      </div>
    );
  };

  const detail = () => {
    if (!sel) return <p className="muted">{S.lessonsSelectHint}</p>;
    const { pending, confirmed } = lessonsFor(s, sel);
    const startEdit = (l: Lesson, mode: "edit" | "confirm") => setEditing({ id: l.id, mode, text: l.text });
    const editor = (l: Lesson) =>
      editing && editing.id === l.id ? (
        <div className="lesson-editor">
          <textarea data-testid={`lesson-text-${l.id}`} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} rows={3} />
          <div className="lessons-row">
            <button
              className="primary"
              data-testid={`lesson-edit-confirm-${l.id}`}
              disabled={!editing.text.trim()}
              onClick={async () => {
                const a: LessonAction = editing.mode === "confirm" ? { op: "confirm", id: l.id, text: editing.text.trim() } : { op: "edit", id: l.id, text: editing.text.trim() };
                if (await act(`lesson-${l.id}`, a)) setEditing(null);
              }}
            >
              {editing.mode === "confirm" ? S.lessonsSaveConfirm : S.lessonsSave}
            </button>
            <button onClick={() => setEditing(null)}>{S.lessonsCancel}</button>
          </div>
        </div>
      ) : null;
    const isEditing = (l: Lesson) => editing?.id === l.id;
    const toggleCheck = (id: number) => setChecked((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
    const picked = confirmed.filter((l) => checked.includes(l.id));
    const startMerge = () => {
      const [a, b] = picked;
      const keep = b.hits > a.hits ? b : a;
      const drop = keep === a ? b : a;
      setMerging({ keepId: keep.id, dropId: drop.id, text: `${a.text}\n${b.text}` });
    };
    return (
      <div className="lessons-detail">
        <h3>{S.lessonsPendingTitle}</h3>
        {pending.length === 0 && <p className="muted">{S.lessonsNoPending}</p>}
        {pending.map((l) => (
          <div key={l.id} className="lesson pending" data-testid={`lesson-${l.id}`}>
            <p className="lesson-text">{l.text}</p>
            {l.why && <p className="muted">{S.lessonsWhy(l.why)}</p>}
            {sources(l)}
            {isEditing(l) ? editor(l) : (
              <div className="lessons-row">
                <button className="primary" data-testid={`lesson-confirm-${l.id}`} onClick={() => void act(`lesson-${l.id}`, { op: "confirm", id: l.id })}>{S.lessonsConfirm}</button>
                <button data-testid={`lesson-edit-${l.id}`} onClick={() => startEdit(l, "confirm")}>{S.lessonsEditConfirm}</button>
                <button data-testid={`lesson-reject-${l.id}`} onClick={() => void act(`lesson-${l.id}`, { op: "reject", id: l.id })}>{S.lessonsReject}</button>
              </div>
            )}
            {err(`lesson-${l.id}`)}
          </div>
        ))}
        <h3>{S.lessonsConfirmedTitle}</h3>
        {confirmed.length === 0 && <p className="muted">{S.lessonsNoConfirmed}</p>}
        {picked.length === 2 && !merging && (
          <button data-testid="lessons-merge" onClick={startMerge}>{S.lessonsMerge}</button>
        )}
        {merging && (
          <div className="lesson-editor">
            <textarea data-testid="lessons-merge-text" value={merging.text} onChange={(e) => setMerging({ ...merging, text: e.target.value })} rows={4} />
            <div className="lessons-row">
              <button
                className="primary"
                data-testid="lessons-merge-save"
                disabled={!merging.text.trim()}
                onClick={async () => {
                  if (await act(`lesson-${merging.keepId}`, { op: "merge", keepId: merging.keepId, dropId: merging.dropId, text: merging.text.trim() })) {
                    setMerging(null);
                    setChecked([]);
                  }
                }}
              >
                {S.lessonsMergeSave}
              </button>
              <button onClick={() => setMerging(null)}>{S.lessonsCancel}</button>
            </div>
          </div>
        )}
        {confirmed.map((l) => {
          const dkey = `lesson-${l.id}`;
          const deleting = confirmingDelete === dkey;
          return (
            <div key={l.id} className={`lesson confirmed${l.status === "disabled" ? " disabled" : ""}`} data-testid={`lesson-${l.id}`}>
              <label className="lesson-check">
                <input type="checkbox" data-testid={`lesson-check-${l.id}`} checked={checked.includes(l.id)} onChange={() => toggleCheck(l.id)} />
                <span className="lesson-text">{l.text}</span>
                {l.status === "disabled" && <span className="pill none">{S.lessonsDisabledTag}</span>}
              </label>
              <p className="muted">{S.lessonsHits(l.hits)} · {S.lessonsLastSeen(formatTime(l.lastSeenAt))}</p>
              {sources(l)}
              {isEditing(l) ? editor(l) : (
                <div className="lessons-row">
                  <button data-testid={`lesson-edit-${l.id}`} onClick={() => startEdit(l, "edit")}>{S.lessonsEdit}</button>
                  <button data-testid={`lesson-toggle-${l.id}`} onClick={() => void act(dkey, { op: "setDisabled", id: l.id, disabled: l.status !== "disabled" })}>
                    {l.status === "disabled" ? S.lessonsEnable : S.lessonsDisable}
                  </button>
                  <button
                    className={deleting ? "danger" : undefined}
                    data-testid={`lesson-delete-${l.id}`}
                    onClick={() => {
                      if (!deleting) return setConfirmingDelete(dkey);
                      setConfirmingDelete(null);
                      void act(dkey, { op: "delete", id: l.id });
                    }}
                  >
                    {deleting ? S.lessonsDeleteConfirm : S.lessonsDelete}
                  </button>
                </div>
              )}
              {err(dkey)}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="page lessons-page">
      <h2>{S.lessons}</h2>
      <p className="muted">{S.lessonsIntro}</p>
      {noRepos ? (
        <p className="muted" data-testid="lessons-empty">{S.lessonsEmpty}</p>
      ) : (
        <>
          <div className="lessons-tree">{lessonsTree(s).map(productBlock)}</div>
          {s.unknownRepos.length > 0 && (
            <ul className="lessons-unknown muted">
              {s.unknownRepos.map((u) => (
                <li key={u.path}>{u.path} · {u.reason === "no_remote" ? S.lessonsNoRemote : S.lessonsNotGit}</li>
              ))}
            </ul>
          )}
          {s.suggestions.map((sg, i) => (
            <div key={sg.slugs.join(",")} className="lessons-suggest" data-testid={`lessons-suggest-${i}`}>
              <span>{S.lessonsSuggest(sg.slugs, sg.together)}</span>
              <button data-testid={`lessons-make-product-${i}`} onClick={() => {
                  setNewName(sg.slugs[0].split("/").pop() ?? sg.slugs[0]);
                  setNewSlugs(sg.slugs);
                }}
              >
                {S.lessonsMakeProduct}
              </button>
            </div>
          ))}
          <div className="lessons-new-product">
            <h3>{S.lessonsNewProduct}</h3>
            <input data-testid="lessons-new-name" placeholder={S.lessonsProductName} value={newName} onChange={(e) => setNewName(e.target.value)} />
            {s.repos.map((r) => (
              <label key={r.slug} className="lessons-pick">
                <input
                  type="checkbox"
                  data-testid={`lessons-new-repo-${r.slug}`}
                  checked={newSlugs.includes(r.slug)}
                  onChange={() => setNewSlugs((c) => (c.includes(r.slug) ? c.filter((x) => x !== r.slug) : [...c, r.slug]))}
                />
                {r.slug}
              </label>
            ))}
            <button
              className="primary"
              data-testid="lessons-create-product"
              disabled={!newName.trim()}
              onClick={async () => {
                if (await act("new-product", { op: "createProduct", name: newName.trim(), slugs: newSlugs })) {
                  setNewName("");
                  setNewSlugs([]);
                }
              }}
            >
              {S.create}
            </button>
            {err("new-product")}
          </div>
          {detail()}
        </>
      )}
    </div>
  );
}
