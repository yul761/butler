// 谁该动的颜色（UI 重做 §5.1）。单独一个文件：strings.ts 也要用这个类型，不能连带引进 .tsx。
import type { Turn } from "../../shared/turn";

export type TurnTone = "ask" | "merge" | "stuck" | "shipherd" | "agent" | "external" | "done" | "idle";

/** 颜色只表示谁该动（spec §5.1 的表）。 */
export function turnTone(turn: Turn): TurnTone {
  if (turn.owner !== "you") return turn.owner;
  switch (turn.kind) {
    case "answer":
    case "review": return "ask";
    case "merge": return "merge";
    case "stuck":
    case "unattended": return "stuck";
    case "shipherd": return "shipherd";
  }
}
