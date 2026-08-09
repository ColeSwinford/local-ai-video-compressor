import './style.css';
import { CompressorPipeline } from './pipeline/compressor';
import { initModal } from './ui/modal';
import { setStatus, updateProgress, logMessage } from './ui/progress';
import { triggerDownload } from './utils/formatters';
import type { LogType, StatusState } from './types';

// Re-export helpers for backwards compatibility
export { getTrueDuration, getValidDuration, formatBytes } from './utils/formatters';

// DOM Element References (initialized during initApp)
let fileInput: HTMLInputElement;
let dropzone: HTMLDivElement;
let dropzoneContainer: HTMLDivElement;
let sourceVideoContainer: HTMLDivElement;
let sourceVideoPlayer: HTMLVideoElement;
let changeFileBtn: HTMLButtonElement;
let closeBtn: HTMLSpanElement;
let startBtn: HTMLButtonElement;
let canvas: HTMLCanvasElement;
let canvasCtx: CanvasRenderingContext2D;
let canvasPlaceholder: HTMLDivElement;

let previewVideoSource: HTMLVideoElement;
let outputVideoPlayer: HTMLVideoElement;

let resolutionSelect: HTMLSelectElement;
let fpsSelect: HTMLSelectElement;
let targetSizeRange: HTMLInputElement;
let targetSizeNumber: HTMLInputElement;

let statusBadge: HTMLDivElement;
let statusText: HTMLSpanElement;

let progressContainer: HTMLDivElement;
let progressBar: HTMLDivElement;
let progressPercent: HTMLSpanElement;
let progressLabel: HTMLSpanElement;

let downloadContainer: HTMLDivElement;
let downloadBtn: HTMLButtonElement;

let srcFilename: HTMLSpanElement;
let srcSize: HTMLSpanElement;
let srcResolution: HTMLSpanElement;
let srcDuration: HTMLSpanElement;
let srcCodec: HTMLSpanElement;

let metaCodec: HTMLSpanElement;
let metaResolution: HTMLSpanElement;
let metaExtradata: HTMLSpanElement;
let metaBitrate: HTMLSpanElement;
let metaFrames: HTMLSpanElement;
let metaFps: HTMLSpanElement;
let metaSize: HTMLSpanElement;
let metaSavings: HTMLSpanElement;

let logsTerminal: HTMLDivElement;
let clearLogsBtn: HTMLButtonElement;

// Application State
let activePipeline: CompressorPipeline | null = null;
let pendingFile: File | null = null;
let cachedFile: File | null = null;
let selectedTargetSizeMB = 10;
let activeDownloadUrl: string | null = null;
let activeDownloadFilename = 'compressed_video.mp4';
export let audioBitrate = 128_000;

/**
 * Log message wrapper for UI terminal and console.
 */
export function log(text: string, type: LogType = 'info') {
  logMessage(logsTerminal, text, type);
}

/**
 * Handles instant source video preview loading, dynamic target size max capping, and caches File in state.
 */
function handleFileSelection(file: File) {
  if (!file) return;
  cachedFile = file;
  pendingFile = file;

  // Explicitly reset target size state to 10 MB default upon new file upload
  selectedTargetSizeMB = 10;
  if (targetSizeNumber) targetSizeNumber.value = '10';
  if (targetSizeRange) targetSizeRange.value = '10';

  // Dynamic Target Size Slider Capping based on source file size & explicit state sync
  const sourceSizeMB = file.size / (1024 * 1024);
  const maxTargetMB = Math.max(2, Math.floor(sourceSizeMB - 0.5));

  if (targetSizeRange) {
    targetSizeRange.max = maxTargetMB.toString();
  }
  if (targetSizeNumber) {
    targetSizeNumber.max = maxTargetMB.toString();
    if (selectedTargetSizeMB > maxTargetMB) {
      selectedTargetSizeMB = maxTargetMB;
      targetSizeNumber.value = maxTargetMB.toString();
      if (targetSizeRange) targetSizeRange.value = maxTargetMB.toString();
    }
  }

  // UI State Machine: Hide dropzone and show source video player
  if (dropzoneContainer) dropzoneContainer.classList.add('hidden');
  if (sourceVideoContainer) sourceVideoContainer.classList.remove('hidden');
  if (changeFileBtn) changeFileBtn.classList.remove('hidden');

  if (srcFilename) srcFilename.textContent = file.name;
  if (srcSize) srcSize.textContent = `${sourceSizeMB.toFixed(2)} MB`;
  if (startBtn) {
    startBtn.disabled = false;
    startBtn.textContent = 'Start Compression';
  }

  log(`[System] File selected & cached: ${file.name} (${sourceSizeMB.toFixed(2)} MB, Target: ${selectedTargetSizeMB} MB)`, 'info');

  if (outputVideoPlayer) {
    outputVideoPlayer.classList.add('hidden');
    outputVideoPlayer.src = '';
  }
  if (canvas) {
    canvas.style.display = 'block';
  }

  // Load file into source video player for instant dual-player comparison
  if (sourceVideoPlayer) {
    sourceVideoPlayer.src = URL.createObjectURL(file);
  }

  // Instant First-Frame Preview Extraction & Metadata Population
  if (previewVideoSource) {
    const objectUrl = URL.createObjectURL(file);
    previewVideoSource.src = objectUrl;

    const onMetadata = () => {
      previewVideoSource.removeEventListener('loadedmetadata', onMetadata);
      const w = previewVideoSource.videoWidth || 1920;
      const h = previewVideoSource.videoHeight || 1080;
      const d = previewVideoSource.duration || 0;

      if (srcResolution) srcResolution.textContent = `${w} × ${h}`;
      if (srcDuration) srcDuration.textContent = `${d.toFixed(1)}s`;

      previewVideoSource.currentTime = 0.001;
    };

    const onSeeked = () => {
      previewVideoSource.removeEventListener('seeked', onSeeked);

      if (canvas && canvasCtx) {
        canvas.width = previewVideoSource.videoWidth || 1920;
        canvas.height = previewVideoSource.videoHeight || 1080;
        canvasCtx.drawImage(previewVideoSource, 0, 0, canvas.width, canvas.height);
      }
      if (canvasPlaceholder) canvasPlaceholder.style.display = 'none';
    };

    previewVideoSource.addEventListener('loadedmetadata', onMetadata);
    previewVideoSource.addEventListener('seeked', onSeeked);
    previewVideoSource.load();
  }
}

/**
 * Reset UI metrics and state machine
 */
function resetUI() {
  if (srcFilename) srcFilename.textContent = '—';
  if (srcSize) srcSize.textContent = '—';
  if (srcResolution) srcResolution.textContent = '—';
  if (srcDuration) srcDuration.textContent = '—';
  if (srcCodec) srcCodec.textContent = '—';

  if (metaCodec) metaCodec.textContent = 'H.264 High Profile (avc1.64002a)';
  if (metaResolution) metaResolution.textContent = '—';
  if (metaExtradata) metaExtradata.textContent = '—';
  if (metaBitrate) metaBitrate.textContent = '—';
  if (metaFrames) metaFrames.textContent = '0';
  if (metaFps) metaFps.textContent = '0 FPS';
  if (metaSize) metaSize.textContent = '—';
  if (metaSavings) metaSavings.textContent = '—';

  if (progressContainer) progressContainer.classList.add('hidden');
  if (downloadContainer) downloadContainer.classList.add('hidden');
  if (progressBar) {
    progressBar.style.width = '0%';
    progressBar.classList.remove('complete');
  }
  if (progressPercent) progressPercent.textContent = '0%';

  if (sourceVideoPlayer) {
    sourceVideoPlayer.src = '';
  }
  if (sourceVideoContainer) sourceVideoContainer.classList.add('hidden');
  if (dropzoneContainer) dropzoneContainer.classList.remove('hidden');
  if (changeFileBtn) changeFileBtn.classList.add('hidden');

  if (outputVideoPlayer) {
    outputVideoPlayer.classList.add('hidden');
    outputVideoPlayer.src = '';
  }
  if (canvas) {
    canvas.style.display = 'block';
  }

  if (activeDownloadUrl) {
    URL.revokeObjectURL(activeDownloadUrl);
    activeDownloadUrl = null;
  }

  if (activePipeline) {
    activePipeline.cancel();
    activePipeline = null;
  }
}

/**
 * Trigger compression workflow
 */
async function processFile(file: File) {
  if (!file) return;

  if (activePipeline) {
    activePipeline.cancel();
    activePipeline = null;
  }

  activePipeline = new CompressorPipeline();

  const targetMB = parseFloat(targetSizeNumber?.value || targetSizeRange?.value || '10') || 10;
  selectedTargetSizeMB = targetMB;

  const resMode = resolutionSelect?.value || 'auto';
  const selectedFps = fpsSelect?.value || 'auto';

  try {
    const result = await activePipeline.processFile({
      file,
      targetMB: selectedTargetSizeMB,
      resMode,
      selectedFps,
      canvas,
      canvasCtx,
      canvasPlaceholder,
      outputVideoPlayer,
      onProgress: (percent, labelText) => {
        updateProgress(
          progressContainer,
          progressBar,
          progressPercent,
          progressLabel,
          percent,
          labelText,
          percent === 100
        );
      },
      onStatusChange: (state: StatusState, text: string) => {
        setStatus(statusBadge, statusText, state, text);
      },
      onLog: (text: string, type?: LogType) => {
        log(text, type);
      },
      onFrameDecoded: (frameCount: number, _pass: 1 | 2, fpsText: string) => {
        if (metaFrames) metaFrames.textContent = frameCount.toString();
        if (metaFps) metaFps.textContent = fpsText;
      },
      onReadyInfo: (info) => {
        if (srcCodec) srcCodec.textContent = info.codec;
        if (metaCodec) metaCodec.textContent = 'H.264 High Profile (avc1.64002a)';

        const isScaled = info.targetWidth !== info.width || info.targetHeight !== info.height;
        if (metaResolution) {
          metaResolution.textContent = isScaled
            ? `${info.width}×${info.height} → ${info.targetWidth}×${info.targetHeight}`
            : `${info.width} × ${info.height}`;
        }

        if (info.description && metaExtradata) {
          metaExtradata.textContent = `${info.description.byteLength} B`;
        }
      },
    });

    activeDownloadUrl = result.url;
    activeDownloadFilename = result.filename;

    if (metaBitrate) metaBitrate.textContent = `${result.avgKbps} kbps (Pass 2 VBR)`;
    if (metaSize) metaSize.textContent = `${result.sizeMb} MB`;
    if (file.size > 0 && metaSavings) {
      metaSavings.textContent = `${result.savingsPct > 0 ? '-' : '+'}${Math.abs(result.savingsPct)}%`;
    }

    if (outputVideoPlayer && canvas) {
      outputVideoPlayer.src = result.url;
      outputVideoPlayer.classList.remove('hidden');
      canvas.style.display = 'none';
    }

    if (downloadContainer) downloadContainer.classList.remove('hidden');

    if (startBtn) {
      startBtn.disabled = false;
      startBtn.textContent = 'Re-Compress Video';
    }
  } catch (err: any) {
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.textContent = 'Re-Try Compression';
    }
  }
}

/**
 * Attaches all DOM event listeners safely after DOM is loaded.
 */
function initApp() {
  fileInput = document.getElementById('file-input') as HTMLInputElement;
  dropzone = document.getElementById('dropzone') as HTMLDivElement;
  dropzoneContainer = document.getElementById('dropzone-container') as HTMLDivElement;
  sourceVideoContainer = document.getElementById('source-video-container') as HTMLDivElement;
  sourceVideoPlayer = document.getElementById('source-video-player') as HTMLVideoElement;
  changeFileBtn = document.getElementById('change-file-btn') as HTMLButtonElement;
  closeBtn = document.getElementById('close-btn') as HTMLSpanElement;
  startBtn = document.getElementById('startBtn') as HTMLButtonElement;
  canvas = document.getElementById('canvas') as HTMLCanvasElement;
  if (canvas) {
    canvasCtx = canvas.getContext('2d') as CanvasRenderingContext2D;
  }
  canvasPlaceholder = document.getElementById('canvas-placeholder') as HTMLDivElement;

  previewVideoSource = document.getElementById('preview-video-source') as HTMLVideoElement;
  outputVideoPlayer = document.getElementById('output-video-player') as HTMLVideoElement;

  resolutionSelect = document.getElementById('resolution-select') as HTMLSelectElement;
  fpsSelect = document.getElementById('fps-select') as HTMLSelectElement;
  targetSizeRange = document.getElementById('target-size-range') as HTMLInputElement;
  targetSizeNumber = document.getElementById('target-size-number') as HTMLInputElement;

  statusBadge = document.getElementById('status-badge') as HTMLDivElement;
  statusText = document.getElementById('status-text') as HTMLSpanElement;

  progressContainer = document.getElementById('progress-container') as HTMLDivElement;
  progressBar = document.getElementById('progress-bar') as HTMLDivElement;
  progressPercent = document.getElementById('progress-percent') as HTMLSpanElement;
  progressLabel = document.getElementById('progress-label') as HTMLSpanElement;

  downloadContainer = document.getElementById('download-container') as HTMLDivElement;
  downloadBtn = document.getElementById('download-btn') as HTMLButtonElement;

  srcFilename = document.getElementById('src-filename') as HTMLSpanElement;
  srcSize = document.getElementById('src-size') as HTMLSpanElement;
  srcResolution = document.getElementById('src-resolution') as HTMLSpanElement;
  srcDuration = document.getElementById('src-duration') as HTMLSpanElement;
  srcCodec = document.getElementById('src-codec') as HTMLSpanElement;

  metaCodec = document.getElementById('meta-codec') as HTMLSpanElement;
  metaResolution = document.getElementById('meta-resolution') as HTMLSpanElement;
  metaExtradata = document.getElementById('meta-extradata') as HTMLSpanElement;
  metaBitrate = document.getElementById('meta-bitrate') as HTMLSpanElement;
  metaFrames = document.getElementById('meta-frames') as HTMLSpanElement;
  metaFps = document.getElementById('meta-fps') as HTMLSpanElement;
  metaSize = document.getElementById('meta-size') as HTMLSpanElement;
  metaSavings = document.getElementById('meta-savings') as HTMLSpanElement;

  logsTerminal = document.getElementById('logs-terminal') as HTMLDivElement;
  clearLogsBtn = document.getElementById('clear-logs') as HTMLButtonElement;

  // UI Input Synchronization & Explicit Unified Target Size State Guarantee
  if (targetSizeRange && targetSizeNumber) {
    const initVal = parseFloat(targetSizeNumber.value || targetSizeRange.value || '10') || 10;
    selectedTargetSizeMB = initVal;
    targetSizeNumber.value = initVal.toString();
    targetSizeRange.value = initVal.toString();

    targetSizeRange.addEventListener('input', () => {
      targetSizeNumber.value = targetSizeRange.value;
      selectedTargetSizeMB = parseFloat(targetSizeRange.value) || 10;
    });

    targetSizeNumber.addEventListener('input', () => {
      let val = parseFloat(targetSizeNumber.value);
      if (isNaN(val)) val = 10;
      const maxVal = parseFloat(targetSizeRange.max || '50');
      val = Math.min(maxVal, Math.max(1, val));
      targetSizeNumber.value = val.toString();
      targetSizeRange.value = val.toString();
      selectedTargetSizeMB = val;
    });
  }

  // File Input Change Handler
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.files && target.files[0]) {
        resetUI();
        handleFileSelection(target.files[0]);
      }
    });
  }

  // Drag & Drop Handlers
  if (dropzone) {
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
        resetUI();
        handleFileSelection(e.dataTransfer.files[0]);
      }
    });
  }

  // Change File Button Handler
  if (changeFileBtn) {
    changeFileBtn.addEventListener('click', () => {
      cachedFile = null;
      pendingFile = null;
      resetUI();
      if (fileInput) fileInput.value = '';
      if (canvasPlaceholder) canvasPlaceholder.style.display = 'flex';
      log('[System] File un-cached. Waiting for new video upload.', 'info');
    });
  }

  // Window Close Button Handler (Red dot)
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      cachedFile = null;
      pendingFile = null;
      resetUI();
      if (fileInput) fileInput.value = '';
      if (canvasPlaceholder) canvasPlaceholder.style.display = 'flex';
      log('[System] Window closed. Pipeline state reset to clean initial state.', 'info');

      try {
        window.close();
      } catch {}
    });
  }

  // Start / Re-Compress Button Handler
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      const fileToProcess = cachedFile || pendingFile;
      if (!fileToProcess) return;
      startBtn.disabled = true;
      processFile(fileToProcess);
    });
  }

  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      if (activeDownloadUrl) {
        triggerDownload(activeDownloadUrl, activeDownloadFilename);
      }
    });
  }

  if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (logsTerminal) {
        logsTerminal.innerHTML = '<div class="log-line info">[System] Logs cleared.</div>';
      }
    });
  }

  // Info Modal Event Listeners
  const infoBtn = document.getElementById('info-btn') as HTMLButtonElement;
  const infoModal = document.getElementById('info-modal') as HTMLDivElement;
  const closeInfoBtn = document.getElementById('close-info-btn') as HTMLButtonElement;

  initModal({
    modalEl: infoModal,
    openBtnEl: infoBtn,
    closeBtnEl: closeInfoBtn,
  });

  log('[System] Application initialized. Waiting for MP4 file input.', 'info');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
