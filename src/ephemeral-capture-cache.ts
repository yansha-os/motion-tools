export type EphemeralPngCapture = { expiresAt: number; png?: Buffer };

export const MAX_EPHEMERAL_CAPTURE_BYTES = 24_000_000;

export function cacheEphemeralCapturePng<T extends EphemeralPngCapture>(captures: Map<string, T>, captureId: string, png: Buffer,
  maxBytes = MAX_EPHEMERAL_CAPTURE_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Ephemeral capture cache byte limit must be a positive safe integer.');
  if (png.length > maxBytes) throw new Error(`Capture ${captureId} exceeds the ${maxBytes}-byte in-memory image cache limit.`);
  const capture = captures.get(captureId);
  if (!capture) throw new Error(`Capture ${captureId} is no longer available to cache.`);
  capture.png = png;
  let totalBytes = 0;
  for (const value of captures.values()) totalBytes += value.png?.length ?? 0;
  const evictedCaptureIds: string[] = [];
  for (const [id, value] of captures) {
    if (totalBytes <= maxBytes) break;
    if (id === captureId || !value.png) continue;
    totalBytes -= value.png.length;
    value.png = undefined;
    evictedCaptureIds.push(id);
  }
  if (totalBytes > maxBytes) {
    capture.png = undefined;
    throw new Error('Ephemeral capture cache could not enforce its configured byte limit.');
  }
  return { totalBytes, evictedCaptureIds };
}
