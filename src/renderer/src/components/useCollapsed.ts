import { useEffect, useState } from "react";
import { isCollapsed, onCollapsedChange, setCollapsed } from "../local-prefs";

/** 能收起的区块：状态记在这台机器上，下次打开还是收起的；别处改了（比如点通知）也跟着变。defaultCollapsed：没记录时是收起的。 */
export function useCollapsed(id: string, defaultCollapsed = false): [boolean, () => void] {
  const [collapsed, setState] = useState(() => isCollapsed(id, defaultCollapsed));
  useEffect(() => {
    setState(isCollapsed(id, defaultCollapsed));
    return onCollapsedChange((changed, on) => {
      if (changed === id) setState(on);
    });
  }, [id, defaultCollapsed]);
  return [collapsed, () => setCollapsed(id, !collapsed, defaultCollapsed)];
}
