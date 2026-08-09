/**
 * Calculates target width and height preserving original aspect ratio based on selected resolution cap.
 * Ensures output width and height are even integers as required by WebCodecs encoders.
 */
export function calculateTargetDimensions(
  srcWidth: number,
  srcHeight: number,
  mode: string
): { width: number; height: number } {
  let maxLongEdge = Infinity;
  if (mode === '1080') maxLongEdge = 1920;
  else if (mode === '720') maxLongEdge = 1280;
  else if (mode === '480') maxLongEdge = 854;

  const currentLongEdge = Math.max(srcWidth, srcHeight);
  if (mode === 'auto' || currentLongEdge <= maxLongEdge) {
    return {
      width: srcWidth % 2 === 0 ? srcWidth : srcWidth - 1,
      height: srcHeight % 2 === 0 ? srcHeight : srcHeight - 1,
    };
  }

  const scale = maxLongEdge / currentLongEdge;
  let w = Math.round(srcWidth * scale);
  let h = Math.round(srcHeight * scale);
  if (w % 2 !== 0) w -= 1;
  if (h % 2 !== 0) h -= 1;
  return { width: Math.max(2, w), height: Math.max(2, h) };
}
