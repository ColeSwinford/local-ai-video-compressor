import type { StatusState, LogType } from '../types';

/**
 * Update Status Badge UI
 */
export function setStatus(
  statusBadge: HTMLDivElement | null,
  statusText: HTMLSpanElement | null,
  state: StatusState,
  text: string
): void {
  if (!statusBadge || !statusText) return;
  statusBadge.className = `status-badge ${state === 'ready' ? '' : state}`;
  statusText.textContent = text;
}

/**
 * Update Progress Bar UI
 */
export function updateProgress(
  progressContainer: HTMLDivElement | null,
  progressBar: HTMLDivElement | null,
  progressPercent: HTMLSpanElement | null,
  progressLabel: HTMLSpanElement | null,
  percent: number,
  labelText: string,
  isComplete = false
): void {
  if (progressContainer) progressContainer.classList.remove('hidden');
  if (progressLabel) progressLabel.textContent = labelText;
  if (progressPercent) progressPercent.textContent = `${percent}%`;
  if (progressBar) {
    progressBar.style.width = `${percent}%`;
    if (isComplete) {
      progressBar.classList.add('complete');
    } else {
      progressBar.classList.remove('complete');
    }
  }
}

/**
 * Log message helper to print formatted messages to the UI terminal and console.
 */
export function logMessage(
  logsTerminal: HTMLDivElement | null,
  text: string,
  type: LogType = 'info'
): void {
  if (type === 'error') {
    console.error(`[VideoCompressor] ${text}`);
  } else if (type === 'warn') {
    console.warn(`[VideoCompressor] ${text}`);
  } else {
    console.log(`[VideoCompressor] ${text}`);
  }

  if (!logsTerminal) return;
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const timestamp = new Date().toISOString().substring(11, 19);
  line.textContent = `[${timestamp}] ${text}`;
  logsTerminal.appendChild(line);
  logsTerminal.scrollTop = logsTerminal.scrollHeight;
}

/**
 * Log helper function for console mirroring compatibility
 */
export function log(
  text: string,
  type: LogType = 'info',
  logsTerminal: HTMLDivElement | null = null
): void {
  logMessage(logsTerminal, text, type);
}
