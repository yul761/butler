/**
 * 拼音框要向左移多少像素才不超出容器右边。
 * viewLeft 是拼音框左边相对容器左边的距离。放得下返回 0；比容器还宽就靠左对齐（返回 viewLeft）。
 */
export function compositionShift(input: { viewLeft: number; viewWidth: number; containerWidth: number }): number {
  const { viewLeft, viewWidth, containerWidth } = input;
  if (viewWidth >= containerWidth) return Math.max(0, viewLeft);
  return Math.max(0, viewLeft + viewWidth - containerWidth);
}
