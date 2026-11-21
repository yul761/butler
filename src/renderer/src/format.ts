/** 美元金额：不到 1 美分时多显示两位，免得“$0.00”看起来像没花钱。 */
export function formatUsd(n: number): string {
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
