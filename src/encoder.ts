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
  codec?: string;
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
  private codec: string;
  private description?: Uint8Array;
  private baseConfig: VideoEncoderConfig;

  constructor(config: EncoderMuxerConfig) {
    this.width = config.width;
    this.height = config.height;
    this.currentBitrate = config.bitrate || 2_000_000; // Default 2 Mbps
    this.codec = config.codec || 'avc1.4d002a'; // Standard H.264 Baseline profile
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
            codec: config.audio.codec || 'aac',
            numberOfChannels: config.audio.numberOfChannels,
            sampleRate: config.audio.sampleRate,
          }
        : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });

    // 2. Cache base VideoEncoder configuration enforcing Rec.709 color space and strict CBR (Constant Bitrate)
    this.baseConfig = {
      codec: this.codec,
      width: this.width,
      height: this.height,
      bitrate: this.currentBitrate,
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
      },
    });

    // 4. Configure VideoEncoder with initial Constant Bitrate (CBR) configuration
    this.encoder.configure(this.baseConfig);
  }

  /**
   * Dynamically reconfigures the H.264 VideoEncoder bitrate enforcing strict CBR (Constant Bitrate).
   */
  public reconfigureBitrate(newBitrate: number): boolean {
    if (this.currentBitrate <= 0) return false;
    const diffRatio = Math.abs(newBitrate - this.currentBitrate) / this.currentBitrate;

    if (diffRatio > 0.15 && this.encoder.state === 'configured') {
      this.currentBitrate = newBitrate;
      this.baseConfig = {
        ...this.baseConfig,
        bitrate: newBitrate,
        bitrateMode: 'constant',
      };
      this.encoder.configure(this.baseConfig);
      return true;
    }

    return false;
  }

  public getCurrentBitrate(): number {
    return this.currentBitrate;
  }

  /**
   * Passes a VideoFrame to the VideoEncoder.
   */
  public encodeFrame(frame: VideoFrame, frameIndex: number): void {
    if (this.encoder.state === 'configured') {
      // Force keyframe every 30 frames for stability and seekability
      const isKeyframe = frameIndex % 30 === 0;
      this.encoder.encode(frame, { keyFrame: isKeyframe });
    } else {
      console.warn('[Encoder] VideoEncoder is not in configured state:', this.encoder.state);
    }
  }

  /**
   * Passes an EncodedAudioChunk directly into MP4 Muxer for audio passthrough.
   */
  public addAudioChunk(chunk: EncodedAudioChunk): void {
    this.muxer.addAudioChunk(chunk);
  }

  /**
   * Flushes the encoder queue, finalizes the MP4 muxer, and returns the finished MP4 Blob & Object URL.
   */
  public async finalize(): Promise<{ blob: Blob; url: string; byteSize: number }> {
    console.log('[Encoder] Flushing VideoEncoder processing queue...');
    if (this.encoder.state === 'configured') {
      await this.encoder.flush();
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

  public getFrameCount(): number {
    return this.encodedFrameCount;
  }

  public getEncodeQueueSize(): number {
    return this.encoder?.encodeQueueSize || 0;
  }
}
