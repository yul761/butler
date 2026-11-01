import { useEffect, useState } from "react";
import { isCollapsed, onCollapsedChange, setCollapsed } from "../local-prefs";

/** 能收起的区块：状态记在这台机器上，下次打开还是收起的；别处改了（比如点通知）也跟着变。 */
export function useCollapsed(id: string): [boolean, () => void] {
  const [collapsed, setState] = useState(() => isCollapsed(id));
  useEffect(() => {
    setState(isCollapsed(id));
    return onCollapsedChange((changed, on) => {
      if (changed === id) setState(on);
    });
  }, [id]);
  return [collapsed, () => setCollapsed(id, !collapsed)];
}
