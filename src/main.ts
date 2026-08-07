import './style.css';
import { Demuxer, type DemuxerReadyInfo } from './demuxer';
import { DecoderWrapper } from './decoder';
import { SceneComplexityDetector } from './complexity';
import { EncoderMuxerPipeline, type EncoderMuxerAudioConfig } from './encoder';

// DOM Element References (initialized during initApp)
let fileInput: HTMLInputElement;
let dropzone: HTMLDivElement;
let startBtn: HTMLButtonElement;
let canvas: HTMLCanvasElement;
let canvasCtx: CanvasRenderingContext2D;
let canvasPlaceholder: HTMLDivElement;

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

let metaCodec: HTMLSpanElement;
let metaResolution: HTMLSpanElement;
let metaExtradata: HTMLSpanElement;
let metaBitrate: HTMLSpanElement;
let metaFrames: HTMLSpanElement;
let metaFps: HTMLSpanElement;
let metaSize: HTMLSpanElement;

let logsTerminal: HTMLDivElement;
let clearLogsBtn: HTMLButtonElement;

// AI Module: Scene Complexity Estimation for Temporal AI Compression (Two-Pass CBR)
const complexityDetector = new SceneComplexityDetector({
  modelUrl: '/model.onnx',
  inputWidth: 224,
  inputHeight: 224,
  inferenceStride: 15,
});

let encoderPipeline: EncoderMuxerPipeline | null = null;
let currentDemuxer: Demuxer | null = null;
let currentDecoder: DecoderWrapper | null = null;

// --- TWO-PASS AI ARCHITECTURE STATE ---
interface ComplexityEntry {
  timestamp: number;
  score: number;
  targetBitrate?: number;
}

let isAnalysisPass = true;
let complexityMap: ComplexityEntry[] = [];
let pendingFile: File | null = null;

// Pipeline State Variables
let startTime = 0;
let decodedFrameCount = 0;
let expectedVideoSamples = 0;
let currentTargetWidth = 1920;
let currentTargetHeight = 1080;
let activeDownloadUrl: string | null = null;
let activeDownloadFilename = 'compressed_video.mp4';
let lastReadyInfo: DemuxerReadyInfo | null = null;
let audioConfig: EncoderMuxerAudioConfig | undefined = undefined;
let audioBitrate = 128_000;

/**
 * Log message helper to print formatted messages to the UI terminal.
 */
function logMessage(text: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') {
  if (!logsTerminal) return;
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const timestamp = new Date().toISOString().substring(11, 19);
  line.textContent = `[${timestamp}] ${text}`;
  logsTerminal.appendChild(line);
  logsTerminal.scrollTop = logsTerminal.scrollHeight;
}

/**
 * Update Status Badge UI
 */
function setStatus(state: 'ready' | 'working' | 'complete' | 'error', text: string) {
  if (!statusBadge || !statusText) return;
  statusBadge.className = `status-badge ${state === 'ready' ? '' : state}`;
  statusText.textContent = text;
}

/**
 * Triggers a programmatic file download using a temporary <a> DOM element.
 */
function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Query pre-calculated targetBitrate from complexityMap matching the frame timestamp.
 */
function findClosestComplexityEntry(timestamp: number): ComplexityEntry | undefined {
  if (complexityMap.length === 0) return undefined;
  let closest = complexityMap[0];
  let minDiff = Math.abs(timestamp - closest.timestamp);
  for (let i = 1; i < complexityMap.length; i++) {
    const diff = Math.abs(timestamp - complexityMap[i].timestamp);
    if (diff < minDiff) {
      minDiff = diff;
      closest = complexityMap[i];
    }
  }
  return closest;
}

/**
 * Reset UI metrics and state
 */
function resetUI() {
  if (metaCodec) metaCodec.textContent = '—';
  if (metaResolution) metaResolution.textContent = '—';
  if (metaExtradata) metaExtradata.textContent = '—';
  if (metaBitrate) metaBitrate.textContent = '—';
  if (metaFrames) metaFrames.textContent = '0';
  if (metaFps) metaFps.textContent = '0 FPS';
  if (metaSize) metaSize.textContent = '—';

  if (progressContainer) progressContainer.classList.add('hidden');
  if (downloadContainer) downloadContainer.classList.add('hidden');
  if (progressBar) progressBar.style.width = '0%';
  if (progressPercent) progressPercent.textContent = '0%';

  if (canvasPlaceholder) canvasPlaceholder.style.display = 'flex';

  if (activeDownloadUrl) {
    URL.revokeObjectURL(activeDownloadUrl);
    activeDownloadUrl = null;
  }

  if (currentDemuxer) {
    currentDemuxer.cancel();
    currentDemuxer = null;
  }

  if (currentDecoder) {
    currentDecoder.close();
    currentDecoder = null;
  }

  if (encoderPipeline) {
    encoderPipeline.close();
    encoderPipeline = null;
  }

  complexityDetector.resetFrameCounter();
  decodedFrameCount = 0;
  expectedVideoSamples = 0;
  currentTargetWidth = 1920;
  currentTargetHeight = 1080;
  isAnalysisPass = true;
  complexityMap = [];
  lastReadyInfo = null;
  audioConfig = undefined;
  audioBitrate = 128_000;
}

/**
 * Handles end-to-end processing using Two-Pass AI Architecture for guaranteed target file size
 */
async function processFile(file: File, selectedTargetMB?: number) {
  if (!file) return;

  resetUI();
  activeDownloadFilename = `compressed_ai_2pass_${file.name.replace(/\.[^/.]+$/, '')}.mp4`;
  logMessage(`[System] Selected file: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`, 'info');

  if (progressContainer) progressContainer.classList.remove('hidden');
  if (progressLabel) progressLabel.textContent = 'Pass 1: AI Scene Analysis...';

  // Read target MB dynamically from user input or passed parameter
  const targetMB = selectedTargetMB ?? (parseFloat(targetSizeNumber?.value || '5') || 5);

  // Initialize ONNX WebGPU Scene Complexity Detector
  const isLoaded = await complexityDetector.init();
  if (isLoaded) {
    logMessage('ONNX WebGPU Classification Session initialized (224x224, 15-frame stride)', 'success');
  } else {
    logMessage('ONNX WebGPU classification model pending (/model.onnx). Mock complexity scaffold active.', 'warn');
  }

  // Standard sRGB OffscreenCanvas for 1080p downscaling & native SDR rendering
  let hdrCanvas: OffscreenCanvas | HTMLCanvasElement;
  let hdrCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  if (typeof OffscreenCanvas !== 'undefined') {
    hdrCanvas = new OffscreenCanvas(1, 1);
    hdrCtx = hdrCanvas.getContext('2d', { willReadFrequently: false }) as OffscreenCanvasRenderingContext2D;
  } else {
    hdrCanvas = document.createElement('canvas');
    hdrCtx = hdrCanvas.getContext('2d', { willReadFrequently: false }) as CanvasRenderingContext2D;
  }

  startTime = performance.now();

  try {
    // =========================================================================
    // PASS 1: AI SCENE COMPLEXITY ANALYSIS (Demux + Decode + ONNX Score Mapping)
    // =========================================================================
    isAnalysisPass = true;
    complexityMap = [];
    logMessage('[Pass 1 / 2] Starting AI Scene Complexity Analysis Pass...', 'info');
    setStatus('working', 'Pass 1: AI Analysis...');

    currentDecoder = new DecoderWrapper(canvas, {
      onFrame: async (originalFrame: VideoFrame, frameIndex: number) => {
        let processedFrame: VideoFrame | null = null;

        try {
          // A. Resize 2D Canvas if resolution changed
          if (hdrCanvas.width !== currentTargetWidth || hdrCanvas.height !== currentTargetHeight) {
            hdrCanvas.width = currentTargetWidth;
            hdrCanvas.height = currentTargetHeight;
          }

          // B. Draw VideoFrame onto 2D Canvas (Standard sRGB native rendering)
          hdrCtx.drawImage(originalFrame, 0, 0, currentTargetWidth, currentTargetHeight);

          // Render visual preview on UI canvas
          if (canvas.width !== currentTargetWidth || canvas.height !== currentTargetHeight) {
            canvas.width = currentTargetWidth;
            canvas.height = currentTargetHeight;
          }
          canvasCtx.drawImage(hdrCanvas, 0, 0, currentTargetWidth, currentTargetHeight);

          if (frameIndex === 1 && canvasPlaceholder) {
            canvasPlaceholder.style.display = 'none';
          }

          if (isAnalysisPass) {
            // PASS 1: Run ONNX Scene Complexity Estimation every 15 frames
            const complexityResult = await complexityDetector.processFrame(originalFrame);

            // Store timestamp and complexity score in complexityMap
            complexityMap.push({
              timestamp: originalFrame.timestamp,
              score: complexityResult.score,
            });
          } else {
            // PASS 2: Re-create 1080p VideoFrame WITH timestamp and duration for VideoEncoder
            const timestamp = originalFrame.timestamp;
            const duration = (originalFrame.duration !== null && originalFrame.duration !== undefined)
              ? originalFrame.duration
              : undefined;

            processedFrame = new VideoFrame(hdrCanvas, {
              timestamp,
              duration,
            });

            // Query complexityMap for pre-calculated targetBitrate matching frame timestamp
            const entry = findClosestComplexityEntry(timestamp);
            if (entry && entry.targetBitrate && encoderPipeline) {
              const reconfigured = encoderPipeline.reconfigureBitrate(entry.targetBitrate);
              if (reconfigured) {
                const kbps = Math.round(entry.targetBitrate / 1000);
                if (metaBitrate) metaBitrate.textContent = `${kbps} kbps (Pass 2 CBR)`;
              }
            }

            // Encode processed VideoFrame into WebCodecs VideoEncoder & mp4-muxer
            if (encoderPipeline) {
              encoderPipeline.encodeFrame(processedFrame, frameIndex);
            }
          }
        } finally {
          // CRITICAL MEMORY MANAGEMENT: Explicitly close processed VideoFrame and original VideoFrame
          if (processedFrame) {
            try {
              processedFrame.close();
            } catch {}
          }
          try {
            originalFrame.close();
          } catch {}
        }
      },

      onFrameDecoded: (frameCount, _timestampUs) => {
        decodedFrameCount = frameCount;
        if (metaFrames) metaFrames.textContent = frameCount.toString();

        const now = performance.now();
        const elapsedSec = (now - startTime) / 1000;
        if (elapsedSec > 0 && metaFps) {
          const fps = (frameCount / elapsedSec).toFixed(1);
          metaFps.textContent = `${fps} FPS (${isAnalysisPass ? 'Pass 1' : 'Pass 2'})`;
        }
      },

      onError: (err) => {
        logMessage(`VideoDecoder error: ${err.message || err}`, 'error');
      },
    });

    // Demuxer Setup for Pass 1
    currentDemuxer = new Demuxer({
      onReady: (info: DemuxerReadyInfo) => {
        lastReadyInfo = info;
        expectedVideoSamples = info.nbSamples;
        currentTargetWidth = info.targetWidth;
        currentTargetHeight = info.targetHeight;

        logMessage(
          `Demuxer onReady (Pass 1): codec=${info.codec}, resolution=${info.width}x${info.height} (${info.targetWidth}x${info.targetHeight}), samples=${info.nbSamples}`,
          'info',
        );

        if (metaCodec) metaCodec.textContent = info.codec;
        if (metaResolution) {
          metaResolution.textContent = info.isDownscaled
            ? `${info.width}×${info.height} → ${info.targetWidth}×${info.targetHeight}`
            : `${info.width} × ${info.height}`;
        }

        if (info.description && metaExtradata) {
          metaExtradata.textContent = `${info.description.byteLength} B`;
        }

        if (currentDecoder) {
          currentDecoder.configure(info.codec, info.width, info.height, info.description);
        }

        if (info.audioInfo) {
          const isOpus = info.audioInfo.codec.toLowerCase().includes('opus');
          audioConfig = {
            codec: isOpus ? 'opus' : 'aac',
            numberOfChannels: info.audioInfo.numberOfChannels,
            sampleRate: info.audioInfo.sampleRate,
          };
          audioBitrate = (info.audioInfo as any).bitrate || 128_000;
        }
      },

      onSample: (chunk: EncodedVideoChunk) => {
        currentDecoder?.decode(chunk);
      },

      checkBackpressure: async () => {
        while (
          (currentDecoder?.getDecodeQueueSize() || 0) > 5 ||
          (encoderPipeline?.getEncodeQueueSize() || 0) > 5
        ) {
          await new Promise((r) => setTimeout(r, 10));
        }
      },

      onProgress: (bytesRead: number, totalBytes: number) => {
        const percent = Math.round((bytesRead / totalBytes) * 50); // 0% - 50% for Pass 1
        if (progressBar) progressBar.style.width = `${percent}%`;
        if (progressPercent) progressPercent.textContent = `${percent}% (Pass 1)`;
      },
    });

    // Run Pass 1 File Demuxing & Decoding
    await currentDemuxer.demuxFile(file);
    if (currentDecoder) {
      await currentDecoder.flush();
    }

    logMessage(`[Pass 1 Complete] Analysed ${complexityMap.length} frame samples. Formulating Bit Allocation Budget...`, 'success');

    // =========================================================================
    // BIT ALLOCATION BUDGET CALCULATION (Between Pass 1 & Pass 2)
    // =========================================================================
    if (!lastReadyInfo) {
      throw new Error('Pass 1 analysis failed to parse track metadata.');
    }

    if (complexityMap.length === 0) {
      logMessage(
        `[Pass 1 Warning] Decoded 0 frames during analysis pass (codec: ${lastReadyInfo.codec}). Generating fallback complexity map across ${expectedVideoSamples || 100} frames.`,
        'warn',
      );
      const totalFrames = expectedVideoSamples || 100;
      const durationSecFallback = lastReadyInfo.duration > 0 ? lastReadyInfo.duration / lastReadyInfo.timescale : 3;
      const sampleDurationUs = Math.round((durationSecFallback / totalFrames) * 1_000_000);

      for (let i = 0; i < totalFrames; i++) {
        complexityMap.push({
          timestamp: i * sampleDurationUs,
          score: 0.5,
        });
      }
    }

    const durationSec = lastReadyInfo.duration > 0 ? lastReadyInfo.duration / lastReadyInfo.timescale : 1;
    const totalTargetBits = targetMB * 1024 * 1024 * 8;
    const safeTargetBits = totalTargetBits * 0.95; // 5% container overhead margin for MP4 atom headers
    const audioFootprintBits = audioConfig ? audioBitrate * durationSec : 0;
    const targetVideoBits = Math.max(100_000, safeTargetBits - audioFootprintBits);

    const totalScoreSum = complexityMap.reduce((acc, entry) => acc + entry.score, 0);

    for (let i = 0; i < complexityMap.length; i++) {
      const entry = complexityMap[i];
      const weight = totalScoreSum > 0 ? entry.score / totalScoreSum : 1 / complexityMap.length;
      const segmentBudgetBits = targetVideoBits * weight;

      let segmentDurationSec = 1 / 30; // 30 fps default
      if (i < complexityMap.length - 1) {
        const deltaUs = complexityMap[i + 1].timestamp - entry.timestamp;
        if (deltaUs > 0) segmentDurationSec = deltaUs / 1_000_000;
      }

      let calculatedBitrate = Math.floor(segmentBudgetBits / segmentDurationSec);
      if (calculatedBitrate < 100_000) calculatedBitrate = 100_000; // Safeguard minimum 100 kbps
      entry.targetBitrate = calculatedBitrate;
    }

    const avgBitrate = Math.round(targetVideoBits / durationSec / 1000);
    logMessage(
      `[AI Bit Allocator] Target size: ${targetMB} MB (5% overhead margin: ${(targetVideoBits / 8 / 1024 / 1024).toFixed(2)} MB video budget for ${durationSec.toFixed(1)}s). Average CBR bitrate: ${avgBitrate} kbps across ${complexityMap.length} frames.`,
      'info',
    );

    // =========================================================================
    // PASS 2: AI-GUIDED ENCODING PASS (Re-demux + Re-decode + WebCodecs VideoEncoder)
    // =========================================================================
    isAnalysisPass = false;
    logMessage('[Pass 2 / 2] Starting AI-Guided Encoding Pass...', 'info');
    setStatus('working', 'Pass 2: Encoding MP4...');
    if (progressLabel) progressLabel.textContent = 'Pass 2: Encoding MP4...';

    // Reset Decoder & Complexity Counter for Pass 2
    if (currentDecoder) currentDecoder.reset();
    complexityDetector.resetFrameCounter();

    // Initialize VideoEncoder & MP4 Muxer for Pass 2
    try {
      encoderPipeline = new EncoderMuxerPipeline({
        width: lastReadyInfo.targetWidth,
        height: lastReadyInfo.targetHeight,
        bitrate: complexityMap[0]?.targetBitrate || Math.floor(targetVideoBits / durationSec),
        codec: 'avc1.4d002a',
        description: lastReadyInfo.description,
        audio: audioConfig,
      });
      logMessage(
        `WebCodecs VideoEncoder & MP4 Muxer initialized (${lastReadyInfo.targetWidth}x${lastReadyInfo.targetHeight} @ Two-Pass AI CBR).`,
        'info',
      );
    } catch (err: any) {
      logMessage(`Encoder setup error: ${err?.message || err}`, 'error');
      setStatus('error', 'Encoder Error');
      return;
    }

    // Re-initialize Demuxer for Pass 2
    currentDemuxer = new Demuxer({
      onReady: (info: DemuxerReadyInfo) => {
        if (currentDecoder) {
          currentDecoder.configure(info.codec, info.width, info.height, info.description);
        }
      },

      onSample: (chunk: EncodedVideoChunk) => {
        currentDecoder?.decode(chunk);
      },

      onAudioSample: (chunk: EncodedAudioChunk) => {
        // Pass-through raw EncodedAudioChunk directly into MP4 Muxer during Pass 2
        encoderPipeline?.addAudioChunk(chunk);
      },

      checkBackpressure: async () => {
        while (
          (currentDecoder?.getDecodeQueueSize() || 0) > 5 ||
          (encoderPipeline?.getEncodeQueueSize() || 0) > 5
        ) {
          await new Promise((r) => setTimeout(r, 10));
        }
      },

      onProgress: (bytesRead: number, totalBytes: number) => {
        const percent = 50 + Math.round((bytesRead / totalBytes) * 50); // 50% - 100% for Pass 2
        if (progressBar) progressBar.style.width = `${percent}%`;
        if (progressPercent) progressPercent.textContent = `${percent}% (Pass 2)`;
      },
    });

    // Run Pass 2 File Demuxing & Encoding
    await currentDemuxer.demuxFile(file);

    logMessage(
      `Pass 2 reading complete (${currentDemuxer.getSampleCount()} / ${expectedVideoSamples} video samples demuxed). Flushing VideoDecoder...`,
      'info',
    );

    if (currentDecoder) {
      await currentDecoder.flush();
    }

    // Finalize VideoEncoder & MP4 Muxer
    if (encoderPipeline) {
      logMessage(
        `VideoDecoder flush complete (${encoderPipeline.getFrameCount()} / ${expectedVideoSamples} frames encoded). Finalizing MP4 Muxer file structure...`,
        'info',
      );
      const exportResult = await encoderPipeline.finalize();
      activeDownloadUrl = exportResult.url;

      const sizeMb = (exportResult.byteSize / (1024 * 1024)).toFixed(2);
      if (metaSize) metaSize.textContent = `${sizeMb} MB`;

      logMessage(`Two-Pass Pipeline complete! MP4 generated successfully (${sizeMb} MB). Triggering download...`, 'success');
      if (downloadContainer) downloadContainer.classList.remove('hidden');

      // Trigger automatic browser file download
      triggerDownload(exportResult.url, activeDownloadFilename);
    }

    const totalSec = ((performance.now() - startTime) / 1000).toFixed(2);
    logMessage(
      `Two-Pass AI Pipeline finished! Processed & multiplexed ${decodedFrameCount} frames in ${totalSec}s.`,
      'success',
    );
    setStatus('complete', 'Pipeline Complete');
  } catch (err: any) {
    console.error('[Pipeline Error Detail]:', err);
    logMessage(`Pipeline error: ${err?.stack || err?.message || err}`, 'error');
    setStatus('error', 'Error');
  }
}

/**
 * Attaches all DOM event listeners safely after DOM is loaded.
 */
function initApp() {
  fileInput = document.getElementById('file-input') as HTMLInputElement;
  dropzone = document.getElementById('dropzone') as HTMLDivElement;
  startBtn = document.getElementById('startBtn') as HTMLButtonElement;
  canvas = document.getElementById('canvas') as HTMLCanvasElement;
  if (canvas) {
    canvasCtx = canvas.getContext('2d') as CanvasRenderingContext2D;
  }
  canvasPlaceholder = document.getElementById('canvas-placeholder') as HTMLDivElement;

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

  metaCodec = document.getElementById('meta-codec') as HTMLSpanElement;
  metaResolution = document.getElementById('meta-resolution') as HTMLSpanElement;
  metaExtradata = document.getElementById('meta-extradata') as HTMLSpanElement;
  metaBitrate = document.getElementById('meta-bitrate') as HTMLSpanElement;
  metaFrames = document.getElementById('meta-frames') as HTMLSpanElement;
  metaFps = document.getElementById('meta-fps') as HTMLSpanElement;
  metaSize = document.getElementById('meta-size') as HTMLSpanElement;

  logsTerminal = document.getElementById('logs-terminal') as HTMLDivElement;
  clearLogsBtn = document.getElementById('clear-logs') as HTMLButtonElement;

  // UI Input Synchronization (Slider <-> Number Input)
  if (targetSizeRange && targetSizeNumber) {
    targetSizeRange.addEventListener('input', () => {
      targetSizeNumber.value = targetSizeRange.value;
    });

    targetSizeNumber.addEventListener('input', () => {
      let val = parseFloat(targetSizeNumber.value);
      if (isNaN(val)) val = 5;
      val = Math.min(50, Math.max(1, val));
      targetSizeRange.value = val.toString();
    });
  }

  // File Input Change Handler (scoping target MB dynamically)
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.files && target.files[0]) {
        pendingFile = target.files[0];
        logMessage('[System] File selected, ready to compress', 'info');
        if (startBtn) startBtn.disabled = false;
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
        pendingFile = e.dataTransfer.files[0];
        logMessage('[System] File selected, ready to compress', 'info');
        if (startBtn) startBtn.disabled = false;
      }
    });
  }

  // Start Compression Button Handler
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      if (!pendingFile) return;
      startBtn.disabled = true;
      processFile(pendingFile);
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
    clearLogsBtn.addEventListener('click', () => {
      if (logsTerminal) {
        logsTerminal.innerHTML = '<div class="log-line info">[System] Logs cleared.</div>';
      }
    });
  }

  logMessage('[System] Application initialized. Waiting for MP4 file input.', 'info');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
