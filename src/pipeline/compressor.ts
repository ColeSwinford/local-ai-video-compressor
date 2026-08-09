import { Demuxer, type DemuxerReadyInfo } from './demuxer';
import { DecoderWrapper } from './decoder';
import { SceneComplexityDetector } from './complexity';
import { EncoderMuxerPipeline, type EncoderMuxerAudioConfig } from './encoder';
import { calculateTargetDimensions } from '../utils/dimensions';
import { getTrueDuration } from '../utils/formatters';
import type { ComplexityEntry, CompressionOptions, CompressionResult } from '../types';

/**
 * Query pre-calculated targetBitrate from complexityMap matching the frame timestamp.
 */
function findClosestComplexityEntry(complexityMap: ComplexityEntry[], timestamp: number): ComplexityEntry | undefined {
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

export class CompressorPipeline {
  private complexityDetector: SceneComplexityDetector;
  private currentDemuxer: Demuxer | null = null;
  private currentDecoder: DecoderWrapper | null = null;
  private encoderPipeline: EncoderMuxerPipeline | null = null;
  private isCancelled = false;

  constructor() {
    this.complexityDetector = new SceneComplexityDetector({
      modelUrl: '/model.onnx',
      inputWidth: 224,
      inputHeight: 224,
      inferenceStride: 15,
    });
  }

  public cancel(): void {
    this.isCancelled = true;
    if (this.currentDemuxer) {
      this.currentDemuxer.cancel();
      this.currentDemuxer = null;
    }
    if (this.currentDecoder) {
      this.currentDecoder.close();
      this.currentDecoder = null;
    }
    if (this.encoderPipeline) {
      this.encoderPipeline.close();
      this.encoderPipeline = null;
    }
  }

  public get cancelled(): boolean {
    return this.isCancelled;
  }

  /**
   * Runs the two-pass AI compression pipeline end-to-end.
   */
  public async processFile(options: CompressionOptions): Promise<CompressionResult> {
    this.isCancelled = false;
    const {
      file,
      targetMB,
      resMode,
      selectedFps,
      canvas,
      canvasCtx,
      canvasPlaceholder,
      onProgress,
      onStatusChange,
      onLog,
      onFrameDecoded,
      onReadyInfo,
    } = options;

    const log = (text: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') => {
      if (onLog) onLog(text, type);
    };

    const setStatus = (state: 'ready' | 'working' | 'complete' | 'error', text: string) => {
      if (onStatusChange) onStatusChange(state, text);
    };

    const downloadFilename = `compressed_ai_2pass_${file.name.replace(/\.[^/.]+$/, '')}.mp4`;

    if (onProgress) onProgress(0, 'Pass 1: AI Scene Analysis...');

    let targetIntervalUs = 0;
    let activeFps = 30; // Default baseline framerate
    let lastReadyInfo: DemuxerReadyInfo | null = null;
    let audioConfig: EncoderMuxerAudioConfig | undefined = undefined;

    if (selectedFps !== 'auto') {
      const parsedFps = parseInt(selectedFps, 10);
      if (parsedFps > 0) {
        activeFps = parsedFps;
        targetIntervalUs = Math.round(1_000_000 / parsedFps);
      }
    }

    // Dynamic Keyframe / GOP Distance scaled to active FPS (keyframe every 2 seconds)
    const maxKeyframeDistance = Math.max(15, Math.round(activeFps * 2));

    // Initialize ONNX WebGPU Scene Complexity Detector
    const isLoaded = await this.complexityDetector.init();
    if (isLoaded) {
      log('ONNX WebGPU Classification Session initialized (224x224, 15-frame stride)', 'success');
    } else {
      log('ONNX WebGPU classification model pending (/model.onnx). Mock complexity scaffold active.', 'warn');
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

    const startTime = performance.now();
    let decodedFrameCount = 0;
    let expectedVideoSamples = 0;
    let currentTargetWidth = 1920;
    let currentTargetHeight = 1080;
    let complexityMap: ComplexityEntry[] = [];

    try {
      // =========================================================================
      // PASS 1: AI SCENE COMPLEXITY ANALYSIS (Demux + Decode + ONNX Score Mapping)
      // =========================================================================
      complexityMap = [];
      log(`[Pass 1 / 2] Starting AI Scene Complexity Analysis Pass (Target: ${targetMB} MB)...`, 'info');
      setStatus('working', 'Pass 1: AI Analysis...');

      this.currentDecoder = new DecoderWrapper(canvas, {
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
            const complexityResult = await this.complexityDetector.processFrame(originalFrame);

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

          const total = expectedVideoSamples > 0 ? expectedVideoSamples : 1;
          const percent = Math.min(50, Math.round((frameCount / total) * 50));
          if (onProgress) onProgress(percent, `Pass 1: AI Analysis (${percent}%)`);

          const now = performance.now();
          const elapsedSec = (now - startTime) / 1000;
          if (elapsedSec > 0 && onFrameDecoded) {
            const fps = (frameCount / elapsedSec).toFixed(1);
            onFrameDecoded(frameCount, 1, `${fps} FPS (Pass 1)`);
          }
        },

        onError: (err) => {
          log(`VideoDecoder error in Pass 1: ${err.message || err}`, 'error');
        },
      });

      // Demuxer Setup for Pass 1
      this.currentDemuxer = new Demuxer({
        onReady: (info: DemuxerReadyInfo) => {
          lastReadyInfo = info;
          expectedVideoSamples = info.nbSamples;

          const targetDims = calculateTargetDimensions(info.width, info.height, resMode);
          currentTargetWidth = targetDims.width;
          currentTargetHeight = targetDims.height;

          if (selectedFps === 'auto' && info.nbSamples > 0 && info.duration > 0) {
            const calculatedSrcFps = Math.round(info.nbSamples / (info.duration / info.timescale));
            if (calculatedSrcFps > 0) {
              activeFps = calculatedSrcFps;
            }
          }

          log(
            `Demuxer onReady (Pass 1): sourceCodec=${info.codec}, resolution=${info.width}x${info.height} → target=${currentTargetWidth}x${currentTargetHeight} (Res: ${resMode}, FPS: ${selectedFps}), samples=${info.nbSamples}`,
            'info',
          );

          if (onReadyInfo) {
            onReadyInfo({
              codec: info.codec,
              width: info.width,
              height: info.height,
              targetWidth: currentTargetWidth,
              targetHeight: currentTargetHeight,
              nbSamples: info.nbSamples,
              description: info.description,
            });
          }

          if (this.currentDecoder) {
            this.currentDecoder.configure(info.codec, info.width, info.height, info.description);
          }

          if (info.audioInfo) {
            const isOpus = info.audioInfo.codec.toLowerCase().includes('opus');
            audioConfig = {
              codec: isOpus ? 'opus' : 'aac',
              numberOfChannels: info.audioInfo.numberOfChannels,
              sampleRate: info.audioInfo.sampleRate,
            };
          }
        },

        onSample: (chunk: EncodedVideoChunk) => {
          this.currentDecoder?.decode(chunk);
        },

        checkBackpressure: async () => {
          while (
            (this.currentDecoder?.getDecodeQueueSize() || 0) > 5 ||
            (this.encoderPipeline?.getEncodeQueueSize() || 0) > 5
          ) {
            await new Promise((resolve) => setTimeout(resolve, 4));
          }
        },
      });

      // Run Pass 1 File Demuxing & Decoding
      await this.currentDemuxer.demuxFile(file);
      if (this.currentDecoder) {
        await this.currentDecoder.flush();
      }

      // Await absolute true duration via headless extraction
      const trueDuration = await getTrueDuration(file, this.currentDemuxer.getExactDuration());
      // Fallback to 16,000 bytes/sec if async audio parsing is lagging behind Pass 1
      const audioBytes = this.currentDemuxer.getAudioTrackSize() || Math.floor(trueDuration * 16000);

      // Explicitly teardown Pass 1 Decoder and Demuxer instances
      if (this.currentDecoder) {
        this.currentDecoder.close();
        this.currentDecoder = null;
      }
      if (this.currentDemuxer) {
        this.currentDemuxer.cancel();
        this.currentDemuxer = null;
      }

      log(`[Pass 1 Complete] Analysed ${complexityMap.length} frame samples. Formulating Bit Allocation Budget...`, 'success');

      // =========================================================================
      // BIT ALLOCATION BUDGET CALCULATION & SCENE-CUT KEYFRAME PLACEMENT
      // =========================================================================
      if (!lastReadyInfo) {
        throw new Error('Pass 1 analysis failed to parse track metadata.');
      }

      if (complexityMap.length === 0) {
        log(
          `[Pass 1 Warning] Decoded 0 frames during analysis pass (codec: ${(lastReadyInfo as DemuxerReadyInfo).codec}). Generating fallback complexity map across ${expectedVideoSamples || 100} frames.`,
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
      log(
        `[AI Bit Allocator & GOP Segmenter] Target size: ${targetMB} MB (${(trueDuration || 1).toFixed(1)}s). Avg VBR: ${avgKbps} kbps (High Profile, 55%-220% Range, ${segments.length} Segments, ${currentTargetWidth}x${currentTargetHeight}, Active FPS: ${activeFps}, Max Keyframe Dist: ${maxKeyframeDistance}). Identified ${keyframeCount} keyframes across ${complexityMap.length} surviving frames.`,
        'info',
      );

      // =========================================================================
      // PASS 2: AI-GUIDED ENCODING PASS (Re-demux + Re-decode + Frame Decimation + WebCodecs VideoEncoder)
      // =========================================================================
      let lastKeyframeDeliveryIndex = 1;
      let lastEncodedTimestampUs = -1;

      log('[Pass 2 / 2] Starting AI-Guided Encoding Pass...', 'info');
      setStatus('working', 'Pass 2: Encoding MP4...');
      if (onProgress) onProgress(50, 'Pass 2: Encoding MP4...');

      // Close Pass 1 Decoder to construct a dedicated strictly-synchronous Pass 2 Decoder instance
      if (this.currentDecoder) {
        this.currentDecoder.close();
        this.currentDecoder = null;
      }

      this.complexityDetector.resetFrameCounter();

      // Initialize VideoEncoder & MP4 Muxer for Pass 2
      try {
        this.encoderPipeline = new EncoderMuxerPipeline({
          width: currentTargetWidth,
          height: currentTargetHeight,
          bitrate: targetVideoBitrate,
          framerate: activeFps,
          description: (lastReadyInfo as DemuxerReadyInfo).description,
          audio: audioConfig,
        });
        log(
          `WebCodecs VideoEncoder & MP4 Muxer initialized (${currentTargetWidth}x${currentTargetHeight} @ Two-Pass AI VBR H.264 High Profile, ${activeFps} FPS, ${avgKbps} kbps avg).`,
          'info',
        );
      } catch (err: any) {
        log(`Encoder setup error: ${err?.message || err}`, 'error');
        setStatus('error', 'Encoder Error');
        throw err;
      }

      // Construct dedicated strictly synchronous Pass 2 Decoder with frame decimation & duration alignment
      this.currentDecoder = new DecoderWrapper(canvas, {
        getEncodeQueueSize: () => this.encoderPipeline?.getEncodeQueueSize() || 0,
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
            const entry = findClosestComplexityEntry(complexityMap, timestamp);

            // Determine keyframe decision: detected scene cut or max dynamic keyframe distance boundary
            const isKeyframe = (frameIndex === 1) || (entry?.isKeyframe === true) || (frameIndex - lastKeyframeDeliveryIndex >= maxKeyframeDistance);
            if (isKeyframe) {
              lastKeyframeDeliveryIndex = frameIndex;
            }

            // Encode processed VideoFrame synchronously into WebCodecs VideoEncoder & mp4-muxer
            if (this.encoderPipeline) {
              this.encoderPipeline.encodeFrame(processedFrame, isKeyframe);
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

          const total = expectedVideoSamples > 0 ? expectedVideoSamples : 1;
          const percent = Math.min(100, 50 + Math.round((frameCount / total) * 50));
          if (onProgress) onProgress(percent, `Pass 2: Encoding MP4 (${percent}%)`);

          const now = performance.now();
          const elapsedSec = (now - startTime) / 1000;
          if (elapsedSec > 0 && onFrameDecoded) {
            const fps = (frameCount / elapsedSec).toFixed(1);
            onFrameDecoded(frameCount, 2, `${fps} FPS (Pass 2)`);
          }
        },

        onError: (err) => {
          log(`VideoDecoder error in Pass 2: ${err.message || err}`, 'error');
        },
      });

      // Explicitly set currentDemuxer = null to allow garbage collection before constructing the Pass 2 Demuxer instance
      this.currentDemuxer = null;

      // Re-initialize Demuxer for Pass 2
      this.currentDemuxer = new Demuxer({
        onReady: (info: DemuxerReadyInfo) => {
          if (this.currentDecoder) {
            this.currentDecoder.configure(info.codec, info.width, info.height, info.description);
          }
        },

        onSample: (chunk: EncodedVideoChunk) => {
          this.currentDecoder?.decode(chunk);
        },

        onAudioSample: (chunk: EncodedAudioChunk) => {
          // Pass-through raw EncodedAudioChunk directly into MP4 Muxer during Pass 2
          this.encoderPipeline?.addAudioChunk(chunk);
        },

        checkBackpressure: async () => {
          while (
            (this.currentDecoder?.getDecodeQueueSize() || 0) > 5 ||
            (this.encoderPipeline?.getEncodeQueueSize() || 0) > 5
          ) {
            await new Promise((resolve) => setTimeout(resolve, 4));
          }
        },
      });

      // Run Pass 2 File Demuxing & Encoding
      await this.currentDemuxer.demuxFile(file);

      log(
        `Pass 2 reading complete (${this.currentDemuxer.getSampleCount()} / ${expectedVideoSamples} video samples demuxed). Flushing VideoDecoder...`,
        'info',
      );

      if (this.currentDecoder) {
        await this.currentDecoder.flush();
      }

      const hasPipelineError = (this.currentDecoder?.hasError() || false) || (this.encoderPipeline?.hasError() || false);

      // Explicitly teardown Pass 2 Decoder and Demuxer instances before finalization
      if (this.currentDecoder) {
        this.currentDecoder.close();
        this.currentDecoder = null;
      }
      if (this.currentDemuxer) {
        this.currentDemuxer.cancel();
        this.currentDemuxer = null;
      }

      // Check for mid-stream pipeline errors before finalizing MP4 structure
      if (hasPipelineError) {
        throw new Error('Pipeline aborted due to VideoEncoder/VideoDecoder error mid-stream.');
      }

      let exportResult = { blob: new Blob(), url: '', byteSize: 0 };
      let sizeMb = '0';
      let savingsPct = 0;

      // Finalize VideoEncoder & MP4 Muxer
      if (this.encoderPipeline) {
        log(
          `VideoDecoder flush complete (${this.encoderPipeline.getFrameCount()} / ${expectedVideoSamples} frames encoded). Finalizing MP4 Muxer file structure...`,
          'info',
        );
        exportResult = await this.encoderPipeline.finalize();
        sizeMb = (exportResult.byteSize / (1024 * 1024)).toFixed(2);

        if (file.size > 0) {
          savingsPct = Math.round(((file.size - exportResult.byteSize) / file.size) * 100);
        }

        log(`Two-Pass Pipeline complete! MP4 generated successfully (${sizeMb} MB). Ready for download.`, 'success');
      }

      const totalSec = ((performance.now() - startTime) / 1000).toFixed(1);
      log(
        `Two-Pass AI Pipeline finished! Processed & multiplexed ${decodedFrameCount} frames in ${totalSec}s.`,
        'success',
      );
      
      setStatus('complete', `Compression Complete (Finished in ${totalSec}s)`);
      if (onProgress) onProgress(100, `Complete (${totalSec}s)`);

      return {
        url: exportResult.url,
        filename: downloadFilename,
        byteSize: exportResult.byteSize,
        sizeMb,
        savingsPct,
        durationSec: totalSec,
        decodedFrameCount,
        avgKbps,
      };
    } catch (err: any) {
      console.error('[Pipeline Error Detail]:', err);
      log(`Pipeline error: ${err?.stack || err?.message || err}`, 'error');
      setStatus('error', 'Error');
      throw err;
    }
  }
}
