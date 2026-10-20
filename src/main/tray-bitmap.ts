/** 画一个抗锯齿的实心圆，BGRA 原始像素，供 nativeImage.createFromBitmap 使用（不需要图片资源文件）。 */
export function circleBitmap(size: number, bgr: [number, number, number]): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const alpha = d <= r ? 255 : d <= r + 1 ? Math.round(255 * (r + 1 - d)) : 0;
      const i = (y * size + x) * 4;
      buf[i] = bgr[0];
      buf[i + 1] = bgr[1];
      buf[i + 2] = bgr[2];
      buf[i + 3] = alpha;
    }
  }
  return buf;
}
