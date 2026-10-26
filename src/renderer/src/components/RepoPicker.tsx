import { useState } from "react";
import { api } from "../api";
import { reportError } from "../errors";
import { lastSegment, scanToSelection } from "../repos";
import { S } from "../strings";

interface Props {
  label: string;
  /** 当前要提交的仓库目录。 */
  onChange: (paths: string[]) => void;
  required?: boolean;
  autoFocus?: boolean;
}

/**
 * 选仓库目录（设计文档 2026-10-26）：选的是仓库就用它；是上一层目录就列出下一层的仓库，默认全选。
 * 输入的目录在扫描完成前就先作为结果交出去：主进程会再按同样的规则检查。
 */
export function RepoPicker({ label, onChange, required, autoFocus }: Props) {
  const [dir, setDir] = useState("");
  const [options, setOptions] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [notFound, setNotFound] = useState(false);

  async function scan(value: string) {
    if (!value.trim()) return;
    try {
      const sel = scanToSelection(await api.scanRepos(value.trim()), value.trim());
      setOptions(sel.options);
      setPicked(sel.paths);
      setNotFound(sel.notFound);
      onChange(sel.paths);
    } catch (e) {
      reportError(e);
    }
  }

  function type(value: string) {
    setDir(value);
    setOptions(null);
    setNotFound(false);
    onChange(value.trim() ? [value] : []);
  }

  async function pick() {
    try {
      const chosen = await api.pickDirectory();
      if (!chosen) return;
      setDir(chosen);
      await scan(chosen);
    } catch (e) {
      reportError(e);
    }
  }

  function toggle(path: string, on: boolean) {
    const next = options!.filter((p) => (p === path ? on : picked.includes(p)));
    setPicked(next);
    onChange(next);
  }

  return (
    <>
      <label>
        {label}
        <div className="row">
          <input value={dir} onChange={(e) => type(e.target.value)} onBlur={() => void scan(dir)} required={required} autoFocus={autoFocus} />
          <button type="button" onClick={() => void pick()}>{S.pick}</button>
        </div>
      </label>
      {options && (
        <fieldset className="sub-repos">
          <legend>{S.subReposFound(options.length)}</legend>
          {options.map((p) => (
            <label key={p} className="inline" title={p}>
              <input type="checkbox" checked={picked.includes(p)} onChange={(e) => toggle(p, e.target.checked)} />
              {lastSegment(p)}
            </label>
          ))}
        </fieldset>
      )}
      {notFound && <p className="error">{S.notRepoNorParent}</p>}
    </>
  );
}
