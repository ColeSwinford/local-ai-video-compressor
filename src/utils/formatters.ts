/**
 * Headless Duration Resolver:
 * Spawns a headless video element to parse metadata reliably without DOM race conditions.
 */
export async function getTrueDuration(file: File, fallbackDuration: number): Promise<number> {
  return new Promise((resolve) => {
    const tempVideo = document.createElement('video');
    tempVideo.preload = 'metadata';

    tempVideo.onloadedmetadata = () => {
      URL.revokeObjectURL(tempVideo.src);
      resolve(tempVideo.duration);
    };

    tempVideo.onerror = () => {
      URL.revokeObjectURL(tempVideo.src);
      resolve(fallbackDuration > 0 ? fallbackDuration : 30);
    };

    tempVideo.src = URL.createObjectURL(file);
  });
}

export const getValidDuration = getTrueDuration;

/**
 * Format bytes to human readable MB string.
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(decimals)} MB`;
}

/**
 * Format duration in seconds to string (e.g. 12.4s).
 */
export function formatDuration(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

/**
 * Triggers a programmatic file download using a temporary <a> DOM element.
 */
export function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
