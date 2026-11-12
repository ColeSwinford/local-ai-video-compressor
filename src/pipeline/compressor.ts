import { Demuxer, type DemuxerReadyInfo } from './demuxer';
import { DecoderWrapper } from './decoder';
import { SceneComplexityDetector } from './complexity';
import { EncoderMuxerPipeline, type EncoderMuxerAudioConfig } from './encoder';
import { calculateTargetDimensions } from '../utils/dimensions';
import { getTrueDuration } from '../utils/formatters';
import { allocateBitrates, findClosestComplexityEntry } from './allocator';
import { evaluatePreflightWarnings, isSupportedContainerFile } from './audio';
import type { ComplexityEntry, CompressionOptions, CompressionResult } from '../types';

declare const __ONNX_MODEL_URL__: string | undefined;

export class CompressorPipeline {
  private complexityDetector: SceneComplexityDetector;
  private currentDemuxer: Demuxer | null = null;
  private currentDecoder: DecoderWrapper | null = null;
  private encoderPipeline: EncoderMuxerPipeline | null = null;
  private isCancelled = false;

  constructor() {
    const modelUrl = typeof __ONNX_MODEL_URL__ !== 'undefined' ? __ONNX_MODEL_URL__ : '/model.onnx';
    this.complexityDetector = new SceneComplexityDetector({
      modelUrl,
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

    const containerCheck = isSupportedContainerFile(file.name);
    if (!containerCheck.supported) {
      const extLabel = containerCheck.extension ? `.${containerCheck.extension}` : 'unknown';
      const errMsg = `Unsupported container (${extLabel}). Only MP4, MOV, and M4V containers are currently supported.`;
      log(errMsg, 'error');
      setStatus('error', 'Unsupported Format');
      throw new Error(errMsg);
    }

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
            // Draw every surviving frame to hdrCanvas so VideoFrame(hdrCanvas) encodes the actual frame
            if (hdrCanvas.width !== currentTargetWidth || hdrCanvas.height !== currentTargetHeight) {
              hdrCanvas.width = currentTargetWidth;
              hdrCanvas.height = currentTargetHeight;
            }
            hdrCtx.drawImage(originalFrame, 0, 0, currentTargetWidth, currentTargetHeight);

            // Throttle UI preview canvas copy in Pass 2 (every 5th frame) to reduce DOM canvas overhead
            if (frameIndex === 1 || frameIndex % 5 === 0) {
              if (canvas.width !== currentTargetWidth || canvas.height !== currentTargetHeight) {
                canvas.width = currentTargetWidth;
                canvas.height = currentTargetHeight;
              }
              canvasCtx.drawImage(hdrCanvas, 0, 0, currentTargetWidth, currentTargetHeight);

              if (frameIndex === 1 && canvasPlaceholder) {
                canvasPlaceholder.style.display = 'none';
              }
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

          if (info.audioInfo && info.audioInfo.isMuxerSupported && info.audioInfo.muxerCodec) {
            audioConfig = {
              codec: info.audioInfo.muxerCodec,
              numberOfChannels: info.audioInfo.numberOfChannels,
              sampleRate: info.audioInfo.sampleRate,
            };
          } else {
            audioConfig = undefined;
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

      const allocation = allocateBitrates({
        complexityMap,
        targetMB,
        audioBytes,
        trueDuration,
        targetIntervalUs,
        maxKeyframeDistance,
      });

      complexityMap = allocation.complexityMap;
      const { targetVideoBitrate, avgBitrateBps, segmentCount, keyframeCount } = allocation;
      const avgKbps = Math.round(avgBitrateBps / 1000);

      const readyInfo = lastReadyInfo as DemuxerReadyInfo;
      const preflightWarnings = evaluatePreflightWarnings({
        fileSizeBytes: file.size,
        targetMB,
        durationSec: trueDuration,
        totalAudioTracks: readyInfo.totalAudioTracks,
        selectedAudio: readyInfo.audioInfo
          ? {
              codec: readyInfo.audioInfo.codec,
              isMuxerSupported: readyInfo.audioInfo.isMuxerSupported,
              numberOfChannels: readyInfo.audioInfo.numberOfChannels,
              estimatedAudioBytes: audioBytes,
            }
          : undefined,
        targetVideoBitrate,
      });

      for (const warning of preflightWarnings) {
        log(`[Preflight] ${warning.message}`, warning.level);
      }

      log(`[Bit Allocator] Measured Duration: ${trueDuration.toFixed(2)}s | Audio Size: ${(audioBytes/1024/1024).toFixed(2)}MB | Target Video Bitrate: ${Math.round(targetVideoBitrate/1000)} kbps`);
      log(
        `[AI Bit Allocator & GOP Segmenter] Target size: ${targetMB} MB (${(trueDuration || 1).toFixed(1)}s). Avg VBR: ${avgKbps} kbps (High Profile, 55%-220% Range, ${segmentCount} Segments, ${currentTargetWidth}x${currentTargetHeight}, Active FPS: ${activeFps}, Max Keyframe Dist: ${maxKeyframeDistance}). Identified ${keyframeCount} keyframes across ${complexityMap.length} surviving frames.`,
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

            // Draw every surviving frame to hdrCanvas so VideoFrame(hdrCanvas) encodes the actual frame
            if (hdrCanvas.width !== currentTargetWidth || hdrCanvas.height !== currentTargetHeight) {
              hdrCanvas.width = currentTargetWidth;
              hdrCanvas.height = currentTargetHeight;
            }
            hdrCtx.drawImage(originalFrame, 0, 0, currentTargetWidth, currentTargetHeight);

            // Throttle UI preview canvas copy in Pass 2 (every 5th frame) to reduce DOM canvas overhead
            if (frameIndex === 1 || frameIndex % 5 === 0) {
              if (canvas.width !== currentTargetWidth || canvas.height !== currentTargetHeight) {
                canvas.width = currentTargetWidth;
                canvas.height = currentTargetHeight;
              }
              canvasCtx.drawImage(hdrCanvas, 0, 0, currentTargetWidth, currentTargetHeight);

              if (frameIndex === 1 && canvasPlaceholder) {
                canvasPlaceholder.style.display = 'none';
              }
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
          if (audioConfig) {
            this.encoderPipeline?.addAudioChunk(chunk);
          }
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
      const encoderErrMsg = this.encoderPipeline?.getLastError()?.message;

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
        const detail = encoderErrMsg ? ` (${encoderErrMsg})` : '';
        throw new Error(`Pipeline aborted due to VideoEncoder/VideoDecoder error mid-stream${detail}.`);
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
