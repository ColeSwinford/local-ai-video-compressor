import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

export interface EncoderMuxerAudioConfig {
  codec: 'aac' | 'opus';
  numberOfChannels: number;
  sampleRate: number;
}

export interface EncoderMuxerConfig {
  width: number;
  height: number;
  bitrate?: number;
  framerate?: number;
  description?: Uint8Array;
  audio?: EncoderMuxerAudioConfig;
}

export class EncoderMuxerPipeline {
  private muxer: Muxer<ArrayBufferTarget>;
  private encoder: VideoEncoder;
  private encodedFrameCount = 0;
  private hasSetDecoderConfig = false;
  private width: number;
  private height: number;
  private currentBitrate: number;
  private framerate: number;
  private codec: string;
  private description?: Uint8Array;
  private baseConfig: VideoEncoderConfig;
  private lastTimestampUs = -1;
  private isErrored = false;
  private lastError: DOMException | Error | null = null;
  private framesSinceLastReconfig = 30;

  constructor(config: EncoderMuxerConfig) {
    this.width = config.width;
    this.height = config.height;
    this.currentBitrate = config.bitrate || 2_000_000; // Default 2 Mbps
    this.framerate = config.framerate || 30;
    this.codec = 'avc1.64002a'; // H.264 High Profile, Level 4.2
    this.description = config.description;

    if (typeof VideoEncoder === 'undefined') {
      throw new Error('WebCodecs VideoEncoder API is not supported in this browser environment.');
    }

    // 1. Initialize MP4 Muxer with ArrayBufferTarget & optional Audio Passthrough track
    this.muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: {
        codec: 'avc',
        width: this.width,
        height: this.height,
      },
      audio: config.audio
        ? {
            codec: config.audio.codec === 'opus' ? 'opus' : 'aac',
            numberOfChannels: config.audio.numberOfChannels,
            sampleRate: config.audio.sampleRate,
          }
        : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });

    // 2. Cache base VideoEncoder configuration enforcing Rec.709 color space, CBR mode, and explicit framerate
    this.baseConfig = {
      codec: this.codec,
      width: this.width,
      height: this.height,
      bitrate: this.currentBitrate,
      framerate: this.framerate,
      bitrateMode: 'constant',
      hardwareAcceleration: 'prefer-hardware',
      colorSpace: {
        primaries: 'bt709',
        transfer: 'bt709',
        matrix: 'bt709',
        fullRange: false,
      },
    } as VideoEncoderConfig;

    // 3. Initialize WebCodecs VideoEncoder
    this.encoder = new VideoEncoder({
      output: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => {
        let finalMeta = meta;

        // Guarantee mp4-muxer receives a valid decoderConfig on the first chunk so track.info.decoderConfig is never null
        if (!this.hasSetDecoderConfig) {
          const decoderConfig = meta?.decoderConfig || {
            codec: this.codec,
            codedWidth: this.width,
            codedHeight: this.height,
            description: this.description,
            colorSpace: {
              primaries: 'bt709',
              transfer: 'bt709',
              matrix: 'bt709',
              fullRange: false,
            },
          };

          if (!decoderConfig.colorSpace) {
            (decoderConfig as any).colorSpace = {
              primaries: 'bt709',
              transfer: 'bt709',
              matrix: 'bt709',
              fullRange: false,
            };
          }

          finalMeta = {
            ...meta,
            decoderConfig,
          };

          this.hasSetDecoderConfig = true;
        } else if (finalMeta?.decoderConfig && !finalMeta.decoderConfig.colorSpace) {
          (finalMeta.decoderConfig as any).colorSpace = {
            primaries: 'bt709',
            transfer: 'bt709',
            matrix: 'bt709',
            fullRange: false,
          };
        }

        this.muxer.addVideoChunk(chunk, finalMeta);
        this.encodedFrameCount++;
      },
      error: (err: DOMException) => {
        console.error('[Encoder] WebCodecs VideoEncoder error:', err);
        this.isErrored = true;
        this.lastError = err;
      },
    });

    // 4. Configure VideoEncoder with initial Constant Bitrate (CBR) configuration
    this.encoder.configure(this.baseConfig);
  }

  public get videoEncoder(): VideoEncoder {
    return this.encoder;
  }

  /**
   * Mid-stream re-configuration is disabled to allow hardware VBR rate controller to manage smooth frame distribution.
   */
  public reconfigureBitrate(_newBitrate: number): boolean {
    return false;
  }

  public getCurrentBitrate(): number {
    return this.currentBitrate;
  }

  /**
   * Passes a VideoFrame to the VideoEncoder enforcing strictly monotonic increasing timestamps.
   */
  public encodeFrame(frame: VideoFrame, isKeyframe: boolean): void {
    this.framesSinceLastReconfig++;

    if (this.isErrored) {
      console.warn('[Encoder] Skipping encodeFrame due to VideoEncoder error state.');
      return;
    }

    if (this.encoder.state === 'configured') {
      let validTimestamp = frame.timestamp;
      if (validTimestamp <= this.lastTimestampUs) {
        validTimestamp = this.lastTimestampUs + 1;
      }
      this.lastTimestampUs = validTimestamp;

      if (validTimestamp !== frame.timestamp) {
        const adjustedFrame = new VideoFrame(frame, {
          timestamp: validTimestamp,
          duration: (frame.duration !== null && frame.duration !== undefined) ? frame.duration : undefined,
        });
        try {
          this.encoder.encode(adjustedFrame, { keyFrame: isKeyframe });
        } finally {
          adjustedFrame.close();
        }
      } else {
        this.encoder.encode(frame, { keyFrame: isKeyframe });
      }
    } else {
      console.warn('[Encoder] VideoEncoder is not in configured state:', this.encoder.state);
    }
  }

  /**
   * Passes an EncodedAudioChunk directly into MP4 Muxer for audio passthrough.
   */
  public addAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): void {
    this.muxer.addAudioChunk(chunk, meta);
  }

  /**
   * Flushes the encoder queue, finalizes the MP4 muxer, and returns the finished MP4 Blob & Object URL.
   */
  public async finalize(): Promise<{ blob: Blob; url: string; byteSize: number }> {
    if (this.isErrored) {
      throw new Error(`Pipeline aborted due to VideoEncoder/VideoDecoder error mid-stream (${this.lastError?.message || 'VideoEncoder error'}).`);
    }

    console.log('[Encoder] Flushing VideoEncoder processing queue...');
    if (this.encoder.state === 'configured') {
      await this.encoder.flush();
    }

    if (this.isErrored) {
      throw new Error('Pipeline aborted due to VideoEncoder/VideoDecoder error mid-stream.');
    }

    if (this.encodedFrameCount === 0) {
      throw new Error('No video frames were processed or encoded (0 frames decoded from video track).');
    }

    console.log('[Encoder] Finalizing MP4 Muxer...');
    this.muxer.finalize();

    const buffer = this.muxer.target.buffer;
    const blob = new Blob([buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);

    return {
      blob,
      url,
      byteSize: buffer.byteLength,
    };
  }

  public close(): void {
    if (this.encoder.state !== 'closed') {
      this.encoder.close();
    }
  }

  public hasError(): boolean {
    return this.isErrored;
  }

  public getFrameCount(): number {
    return this.encodedFrameCount;
  }

  public getEncodeQueueSize(): number {
    return this.encoder?.encodeQueueSize || 0;
  }
}
