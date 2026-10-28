import { useEffect, useState } from "react";
import { isCollapsed, setCollapsed } from "../local-prefs";

/** 能收起的区块：状态记在这台机器上，下次打开还是收起的。 */
export function useCollapsed(id: string): [boolean, () => void] {
  const [collapsed, setState] = useState(() => isCollapsed(id));
  useEffect(() => setState(isCollapsed(id)), [id]);
  const toggle = () => {
    setCollapsed(id, !collapsed);
    setState(!collapsed);
  };
  return [collapsed, toggle];
}
