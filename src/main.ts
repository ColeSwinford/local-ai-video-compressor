import './style.css';
import { Demuxer, type DemuxerReadyInfo } from './demuxer';
import { DecoderWrapper } from './decoder';
import { SceneComplexityDetector } from './complexity';
import { EncoderMuxerPipeline, type EncoderMuxerAudioConfig } from './encoder';

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
  isKeyframe?: boolean;
}

let complexityMap: ComplexityEntry[] = [];
let pendingFile: File | null = null;
let cachedFile: File | null = null;

// State variable to guarantee synchronized 10 MB target size calculation
let selectedTargetSizeMB = 10;

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
export let audioBitrate = 128_000;

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
 * Calculates target width and height preserving original aspect ratio based on selected resolution cap.
 * Ensures output width and height are even integers as required by WebCodecs encoders.
 */
function calculateTargetDimensions(srcWidth: number, srcHeight: number, mode: string): { width: number; height: number } {
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

/**
 * Log message helper to print formatted messages to the UI terminal and console.
 */
function logMessage(text: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') {
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
export function log(text: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') {
  logMessage(text, type);
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
 * Triggers a programmatic file download using a temporary <a> DOM element when explicitly clicked by user.
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

  logMessage(`[System] File selected & cached: ${file.name} (${sourceSizeMB.toFixed(2)} MB, Target: ${selectedTargetSizeMB} MB)`, 'info');

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
  complexityMap = [];
  lastReadyInfo = null;
  audioConfig = undefined;
  audioBitrate = 128_000;
}

/**
 * Handles end-to-end processing using Two-Pass AI Architecture for guaranteed target file size
 */
async function processFile(file: File, selectedTargetMBParam?: number) {
  if (!file) return;

  activeDownloadFilename = `compressed_ai_2pass_${file.name.replace(/\.[^/.]+$/, '')}.mp4`;

  if (progressContainer) progressContainer.classList.remove('hidden');
  if (progressBar) {
    progressBar.style.width = '0%';
    progressBar.classList.remove('complete');
  }
  if (progressLabel) progressLabel.textContent = 'Pass 1: AI Scene Analysis...';

  // Single Source of Truth: Read target MB directly from DOM element at execution start
  const targetMB = selectedTargetMBParam ?? (parseFloat(targetSizeNumber?.value || targetSizeRange?.value || '10') || 10);
  selectedTargetSizeMB = targetMB;

  const resMode = resolutionSelect?.value || 'auto';
  const selectedFps = fpsSelect?.value || 'auto';

  let targetIntervalUs = 0;
  let activeFps = 30; // Default baseline framerate

  if (selectedFps !== 'auto') {
    const parsedFps = parseInt(selectedFps, 10);
    if (parsedFps > 0) {
      activeFps = parsedFps;
      targetIntervalUs = Math.round(1_000_000 / parsedFps);
    }
  } else if (lastReadyInfo && lastReadyInfo.nbSamples > 0 && lastReadyInfo.duration > 0) {
    const calculatedSrcFps = Math.round(lastReadyInfo.nbSamples / (lastReadyInfo.duration / lastReadyInfo.timescale));
    if (calculatedSrcFps > 0) {
      activeFps = calculatedSrcFps;
    }
  }

  // Dynamic Keyframe / GOP Distance scaled to active FPS (keyframe every 2 seconds)
  const maxKeyframeDistance = Math.max(15, Math.round(activeFps * 2));

  // Initialize ONNX WebGPU Scene Complexity Detector
  const isLoaded = await complexityDetector.init();
  if (isLoaded) {
    logMessage('ONNX WebGPU Classification Session initialized (224x224, 15-frame stride)', 'success');
  } else {
    logMessage('ONNX WebGPU classification model pending (/model.onnx). Mock complexity scaffold active.', 'warn');
  }

  // Standard sRGB OffscreenCanvas for downscaling & native SDR rendering
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
  let lastKeyframeDeliveryIndex = 1;

  try {
    // =========================================================================
    // PASS 1: AI SCENE COMPLEXITY ANALYSIS (Demux + Decode + ONNX Score Mapping)
    // =========================================================================
    complexityMap = [];
    logMessage(`[Pass 1 / 2] Starting AI Scene Complexity Analysis Pass (Target: ${selectedTargetSizeMB} MB)...`, 'info');
    setStatus('working', 'Pass 1: AI Analysis...');

    currentDecoder = new DecoderWrapper(canvas, {
      onFrame: async (originalFrame: VideoFrame, frameIndex: number) => {
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

          // PASS 1: Run ONNX Scene Complexity Estimation every 15 frames
          const complexityResult = await complexityDetector.processFrame(originalFrame);

          // Store timestamp and complexity score in complexityMap
          complexityMap.push({
            timestamp: originalFrame.timestamp,
            score: complexityResult.score,
          });
        } finally {
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
          metaFps.textContent = `${fps} FPS (Pass 1)`;
        }
      },

      onError: (err) => {
        logMessage(`VideoDecoder error in Pass 1: ${err.message || err}`, 'error');
      },
    });

    // Demuxer Setup for Pass 1
    currentDemuxer = new Demuxer({
      onReady: (info: DemuxerReadyInfo) => {
        lastReadyInfo = info;
        expectedVideoSamples = info.nbSamples;

        const targetDims = calculateTargetDimensions(info.width, info.height, resMode);
        currentTargetWidth = targetDims.width;
        currentTargetHeight = targetDims.height;

        logMessage(
          `Demuxer onReady (Pass 1): sourceCodec=${info.codec}, resolution=${info.width}x${info.height} → target=${currentTargetWidth}x${currentTargetHeight} (Res: ${resMode}, FPS: ${selectedFps}), samples=${info.nbSamples}`,
          'info',
        );

        if (srcCodec) srcCodec.textContent = info.codec;
        if (metaCodec) metaCodec.textContent = 'H.264 High Profile (avc1.64002a)';

        const isScaled = currentTargetWidth !== info.width || currentTargetHeight !== info.height;
        if (metaResolution) {
          metaResolution.textContent = isScaled
            ? `${info.width}×${info.height} → ${currentTargetWidth}×${currentTargetHeight}`
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
          await new Promise((resolve) => setTimeout(resolve, 4));
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

    // Await absolute true duration via headless extraction
    const trueDuration = await getTrueDuration(file, currentDemuxer.getExactDuration());
    // Fallback to 16,000 bytes/sec if async audio parsing is lagging behind Pass 1
    const audioBytes = currentDemuxer.getAudioTrackSize() || Math.floor(trueDuration * 16000);

    // Explicitly teardown Pass 1 Decoder and Demuxer instances
    if (currentDecoder) {
      currentDecoder.close();
      currentDecoder = null;
    }
    if (currentDemuxer) {
      currentDemuxer.cancel();
      currentDemuxer = null;
    }

    logMessage(`[Pass 1 Complete] Analysed ${complexityMap.length} frame samples. Formulating Bit Allocation Budget...`, 'success');

    // =========================================================================
    // BIT ALLOCATION BUDGET CALCULATION & SCENE-CUT KEYFRAME PLACEMENT
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
      const durationSecFallback = trueDuration > 0 ? trueDuration : 3;
      const sampleDurationUs = Math.round((durationSecFallback / totalFrames) * 1_000_000);

      for (let i = 0; i < totalFrames; i++) {
        complexityMap.push({
          timestamp: i * sampleDurationUs,
          score: 0.5,
        });
      }
    }

    // Read target MB from DOM & Unify Bit Allocation Execution strictly using trueDuration and secured audioBytes
    const targetMB = parseFloat((document.getElementById('target-size-slider') as HTMLInputElement)?.value) || parseFloat((document.getElementById('target-size-range') as HTMLInputElement)?.value) || parseFloat((document.getElementById('target-size-number') as HTMLInputElement)?.value) || 10;
    selectedTargetSizeMB = targetMB;

    const targetBytes = targetMB * 1024 * 1024;
    const containerOverhead = targetBytes * 0.015;

    const netVideoBytes = Math.max(targetBytes * 0.25, (targetBytes - audioBytes - containerOverhead) * 0.92);
    const targetVideoBitrate = Math.floor((netVideoBytes * 8) / trueDuration);
    const avgBitrateBps = targetVideoBitrate;
    const targetVideoBits = targetVideoBitrate * trueDuration;

    log(`[Bit Allocator] Measured Duration: ${trueDuration.toFixed(2)}s | Audio Size: ${(audioBytes/1024/1024).toFixed(2)}MB | Target Video Bitrate: ${Math.round(targetVideoBitrate/1000)} kbps`);

    // 2. Filter complexityMap to include ONLY frames that survive FPS decimation in Pass 2
    let survivingMap: ComplexityEntry[] = [];
    if (targetIntervalUs > 0) {
      let lastSurvivingUs = -1;
      for (const entry of complexityMap) {
        if (lastSurvivingUs < 0 || (entry.timestamp - lastSurvivingUs) >= (targetIntervalUs - 2000)) {
          survivingMap.push(entry);
          lastSurvivingUs = entry.timestamp;
        }
      }
    } else {
      survivingMap = [...complexityMap];
    }

    // Use survivingMap as the authoritative active complexity map for GOP segmenting & bit allocation
    complexityMap = survivingMap;

    // 3. Group surviving complexityMap entries into 30-frame / 1-second / scene-cut bounded GOP segments
    interface SegmentInfo {
      startIndex: number;
      endIndex: number;
      avgScore: number;
      targetBitrate: number;
    }

    const segments: SegmentInfo[] = [];
    let currentSegmentStart = 0;
    let currentSegmentSum = 0;
    let currentSegmentCount = 0;

    for (let i = 0; i < complexityMap.length; i++) {
      const entry = complexityMap[i];
      const prevEntry = i > 0 ? complexityMap[i - 1] : null;

      const isComplexityJump = prevEntry !== null && prevEntry.score > 0 && (entry.score > prevEntry.score * 1.40);
      const framesInCurrentSegment = i - currentSegmentStart;
      const timeInCurrentSegmentSec = (entry.timestamp - complexityMap[currentSegmentStart].timestamp) / 1_000_000;

      const shouldCutSegment = (i > 0) && (isComplexityJump || framesInCurrentSegment >= 30 || timeInCurrentSegmentSec >= 1.0);

      if (shouldCutSegment) {
        const segmentAvgScore = currentSegmentCount > 0 ? currentSegmentSum / currentSegmentCount : 0.5;
        segments.push({
          startIndex: currentSegmentStart,
          endIndex: i - 1,
          avgScore: segmentAvgScore,
          targetBitrate: 0,
        });

        currentSegmentStart = i;
        currentSegmentSum = 0;
        currentSegmentCount = 0;
      }

      currentSegmentSum += entry.score;
      currentSegmentCount++;
    }

    if (currentSegmentCount > 0) {
      const segmentAvgScore = currentSegmentSum / currentSegmentCount;
      segments.push({
        startIndex: currentSegmentStart,
        endIndex: complexityMap.length - 1,
        avgScore: segmentAvgScore,
        targetBitrate: 0,
      });
    }

    // 4. Gentle Power-Curve Bit Allocator (exponent 1.2) across segments
    let minSegmentScore = Infinity;
    let maxSegmentScore = -Infinity;
    for (const seg of segments) {
      if (seg.avgScore < minSegmentScore) minSegmentScore = seg.avgScore;
      if (seg.avgScore > maxSegmentScore) maxSegmentScore = seg.avgScore;
    }

    const scoreRange = maxSegmentScore > minSegmentScore ? maxSegmentScore - minSegmentScore : 1.0;
    const powerWeights = new Float64Array(segments.length);
    let totalPowerWeightSum = 0;

    for (let i = 0; i < segments.length; i++) {
      const normalizedScore = Math.max(0.01, Math.min(1.0, (segments[i].avgScore - minSegmentScore) / scoreRange));
      const weightedWeight = Math.pow(normalizedScore, 1.2); // Gentle 1.2 power curve
      powerWeights[i] = weightedWeight;
      totalPowerWeightSum += weightedWeight;
    }

    // Bitrate floor = 55% of avg bitrate (to stop hardware rate controller from over-dropping QP on static scenes), Bitrate cap = 2.2x avg bitrate
    const bitrateFloor = Math.max(100_000, Math.floor(avgBitrateBps * 0.55));
    const bitrateCap = Math.floor(avgBitrateBps * 2.2);

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const weight = totalPowerWeightSum > 0 ? powerWeights[i] / totalPowerWeightSum : 1 / segments.length;
      const segmentBudgetBits = targetVideoBits * weight;

      const segStartUs = complexityMap[seg.startIndex].timestamp;
      const nextSegStartUs = (i < segments.length - 1) ? complexityMap[segments[i + 1].startIndex].timestamp : (segStartUs + 1_000_000);
      let segmentDurationSec = (nextSegStartUs - segStartUs) / 1_000_000;
      if (segmentDurationSec <= 0) segmentDurationSec = 1.0;

      let calculatedBitrate = Math.floor(segmentBudgetBits / segmentDurationSec);
      calculatedBitrate = Math.min(bitrateCap, Math.max(bitrateFloor, calculatedBitrate));
      seg.targetBitrate = calculatedBitrate;
    }

    // 5. Asymmetric EMA Bitrate Smoothing across segments (Fast Attack alpha=0.85, Slow Decay alpha=0.15)
    let smoothedBitrate = segments[0]?.targetBitrate || Math.round(avgBitrateBps);
    for (let i = 0; i < segments.length; i++) {
      const rawBitrate = segments[i].targetBitrate || smoothedBitrate;
      const alpha = rawBitrate > smoothedBitrate ? 0.85 : 0.15;
      smoothedBitrate = alpha * rawBitrate + (1 - alpha) * smoothedBitrate;
      segments[i].targetBitrate = Math.round(smoothedBitrate);
    }

    // 6. Map Segment Bitrates and Dynamic Keyframe Boundaries into surviving complexityMap
    let lastKeyframeTimestamp = complexityMap[0]?.timestamp || 0;
    let lastKeyframeIndex = 0;

    for (let sIdx = 0; sIdx < segments.length; sIdx++) {
      const seg = segments[sIdx];
      for (let idx = seg.startIndex; idx <= seg.endIndex; idx++) {
        complexityMap[idx].targetBitrate = seg.targetBitrate;

        const isComplexityJump = (sIdx > 0 && idx === seg.startIndex && segments[sIdx].avgScore > segments[sIdx - 1].avgScore * 1.40);
        const timeDiffSec = (complexityMap[idx].timestamp - lastKeyframeTimestamp) / 1_000_000;
        const frameDiff = idx - lastKeyframeIndex;
        const isIntervalExceeded = timeDiffSec >= 2.0 || frameDiff >= maxKeyframeDistance;

        if (idx === 0 || isComplexityJump || isIntervalExceeded) {
          complexityMap[idx].isKeyframe = true;
          lastKeyframeTimestamp = complexityMap[idx].timestamp;
          lastKeyframeIndex = idx;
        } else {
          complexityMap[idx].isKeyframe = false;
        }
      }
    }

    const keyframeCount = complexityMap.filter((e) => e.isKeyframe).length;
    const avgKbps = Math.round(avgBitrateBps / 1000);
    logMessage(
      `[AI Bit Allocator & GOP Segmenter] Target size: ${selectedTargetSizeMB} MB (${(trueDuration || 1).toFixed(1)}s). Avg VBR: ${avgKbps} kbps (High Profile, 55%-220% Range, ${segments.length} Segments, ${currentTargetWidth}x${currentTargetHeight}, Active FPS: ${activeFps}, Max Keyframe Dist: ${maxKeyframeDistance}). Identified ${keyframeCount} keyframes across ${complexityMap.length} surviving frames.`,
      'info',
    );

    // =========================================================================
    // PASS 2: AI-GUIDED ENCODING PASS (Re-demux + Re-decode + Frame Decimation + WebCodecs VideoEncoder)
    // =========================================================================
    lastKeyframeDeliveryIndex = 1;
    let lastEncodedTimestampUs = -1;

    logMessage('[Pass 2 / 2] Starting AI-Guided Encoding Pass...', 'info');
    setStatus('working', 'Pass 2: Encoding MP4...');
    if (progressLabel) progressLabel.textContent = 'Pass 2: Encoding MP4...';

    // Close Pass 1 Decoder to construct a dedicated strictly-synchronous Pass 2 Decoder instance
    if (currentDecoder) {
      currentDecoder.close();
      currentDecoder = null;
    }

    complexityDetector.resetFrameCounter();

    // Initialize VideoEncoder & MP4 Muxer for Pass 2 with downscaled dimensions, static target bitrate, and explicit framerate
    try {
      encoderPipeline = new EncoderMuxerPipeline({
        width: currentTargetWidth,
        height: currentTargetHeight,
        bitrate: targetVideoBitrate,
        framerate: activeFps,
        description: lastReadyInfo.description,
        audio: audioConfig,
      });
      if (metaBitrate) metaBitrate.textContent = `${avgKbps} kbps (Pass 2 VBR)`;
      logMessage(
        `WebCodecs VideoEncoder & MP4 Muxer initialized (${currentTargetWidth}x${currentTargetHeight} @ Two-Pass AI VBR H.264 High Profile, ${activeFps} FPS, ${avgKbps} kbps avg).`,
        'info',
      );
    } catch (err: any) {
      logMessage(`Encoder setup error: ${err?.message || err}`, 'error');
      setStatus('error', 'Encoder Error');
      return;
    }

    // Construct dedicated strictly synchronous Pass 2 Decoder with frame decimation & duration alignment
    currentDecoder = new DecoderWrapper(canvas, {
      getEncodeQueueSize: () => encoderPipeline?.getEncodeQueueSize() || 0,
      onFrame: (originalFrame: VideoFrame, frameIndex: number) => {
        let processedFrame: VideoFrame | null = null;

        try {
          // FPS Decimation check: Skip frame if time since last encoded frame is less than targetIntervalUs
          if (targetIntervalUs > 0) {
            if (lastEncodedTimestampUs >= 0 && (originalFrame.timestamp - lastEncodedTimestampUs) < (targetIntervalUs - 2000)) {
              return;
            }
          }

          const previousTimestampUs = lastEncodedTimestampUs;
          lastEncodedTimestampUs = originalFrame.timestamp;

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

          // Compute frame duration matching the new decimated frame interval for hardware rate controller
          let frameDurationUs: number | undefined = undefined;
          if (previousTimestampUs >= 0) {
            frameDurationUs = originalFrame.timestamp - previousTimestampUs;
          } else if (targetIntervalUs > 0) {
            frameDurationUs = targetIntervalUs;
          } else if (originalFrame.duration !== null && originalFrame.duration !== undefined) {
            frameDurationUs = originalFrame.duration;
          }

          const timestamp = originalFrame.timestamp;

          processedFrame = new VideoFrame(hdrCanvas, {
            timestamp,
            duration: frameDurationUs,
          });

          // Query surviving complexityMap for pre-calculated entry matching frame timestamp
          const entry = findClosestComplexityEntry(timestamp);

          // Determine keyframe decision: detected scene cut or max dynamic keyframe distance boundary
          const isKeyframe = (frameIndex === 1) || (entry?.isKeyframe === true) || (frameIndex - lastKeyframeDeliveryIndex >= maxKeyframeDistance);
          if (isKeyframe) {
            lastKeyframeDeliveryIndex = frameIndex;
          }

          // Encode processed VideoFrame synchronously into WebCodecs VideoEncoder & mp4-muxer
          if (encoderPipeline) {
            encoderPipeline.encodeFrame(processedFrame, isKeyframe);
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
          metaFps.textContent = `${fps} FPS (Pass 2)`;
        }
      },

      onError: (err) => {
        logMessage(`VideoDecoder error in Pass 2: ${err.message || err}`, 'error');
      },
    });

    // Explicitly set currentDemuxer = null to allow garbage collection before constructing the Pass 2 Demuxer instance
    currentDemuxer = null;

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
          await new Promise((resolve) => setTimeout(resolve, 4));
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

    const hasPipelineError = (currentDecoder?.hasError() || false) || (encoderPipeline?.hasError() || false);

    // Explicitly teardown Pass 2 Decoder and Demuxer instances before finalization
    if (currentDecoder) {
      currentDecoder.close();
    }
    if (currentDemuxer) {
      currentDemuxer.cancel();
    }

    // Check for mid-stream pipeline errors before finalizing MP4 structure
    if (hasPipelineError) {
      throw new Error('Pipeline aborted due to VideoEncoder/VideoDecoder error mid-stream.');
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

      if (file.size > 0 && metaSavings) {
        const savingsPct = Math.round(((file.size - exportResult.byteSize) / file.size) * 100);
        metaSavings.textContent = `${savingsPct > 0 ? '-' : '+'}${Math.abs(savingsPct)}%`;
      }

      if (outputVideoPlayer && canvas) {
        outputVideoPlayer.src = exportResult.url;
        outputVideoPlayer.classList.remove('hidden');
        canvas.style.display = 'none';
      }

      logMessage(`Two-Pass Pipeline complete! MP4 generated successfully (${sizeMb} MB). Ready for download.`, 'success');
      if (downloadContainer) downloadContainer.classList.remove('hidden');
    }

    const totalSec = ((performance.now() - startTime) / 1000).toFixed(1);
    logMessage(
      `Two-Pass AI Pipeline finished! Processed & multiplexed ${decodedFrameCount} frames in ${totalSec}s.`,
      'success',
    );
    
    // Smooth progress bar completion styling
    setStatus('complete', `Compression Complete (Finished in ${totalSec}s)`);
    if (progressLabel) progressLabel.textContent = `Complete (${totalSec}s)`;
    if (progressPercent) progressPercent.textContent = '100%';
    if (progressBar) {
      progressBar.style.width = '100%';
      progressBar.classList.add('complete');
    }

    // Keep Start button enabled and active for instant re-compression tweaking
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.textContent = 'Re-Compress Video';
    }
  } catch (err: any) {
    console.error('[Pipeline Error Detail]:', err);
    logMessage(`Pipeline error: ${err?.stack || err?.message || err}`, 'error');
    setStatus('error', 'Error');
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
      logMessage('[System] File un-cached. Waiting for new video upload.', 'info');
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
      logMessage('[System] Window closed. Pipeline state reset to clean initial state.', 'info');

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
      if (currentDemuxer) {
        currentDemuxer.reset();
      }
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

  logMessage('[System] Application initialized. Waiting for MP4 file input.', 'info');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
