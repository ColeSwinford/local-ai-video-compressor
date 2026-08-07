export interface VideoDecoderCallbacks {
  onFrame?: (frame: VideoFrame, frameIndex: number) => Promise<void> | void;
  onFrameDecoded?: (frameIndex: number, timestampUs: number) => void;
  onError?: (error: DOMException | Error) => void;
}

export class DecoderWrapper {
  private decoder: VideoDecoder;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private frameCount = 0;
  private callbacks: VideoDecoderCallbacks;

  constructor(canvas: HTMLCanvasElement, callbacks: VideoDecoderCallbacks = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not initialize 2D context on the canvas.');
    }
    this.ctx = ctx;
    this.callbacks = callbacks;

    if (typeof VideoDecoder === 'undefined') {
      throw new Error('WebCodecs VideoDecoder API is not supported in this browser environment.');
    }

    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => this.handleFrame(frame),
      error: (err: DOMException) => {
        console.error('[Decoder] WebCodecs VideoDecoder error:', err);
        if (this.callbacks.onError) {
          this.callbacks.onError(err);
        }
      },
    });
  }

  /**
   * Configures the WebCodecs VideoDecoder synchronously with track parameters and fallback recovery.
   */
  public configure(codec: string, width: number, height: number, description?: Uint8Array): void {
    const normalizedCodec = codec.trim();

    const config: VideoDecoderConfig = {
      codec: normalizedCodec,
      codedWidth: width,
      codedHeight: height,
      hardwareAcceleration: 'no-preference',
    };

    if (description && description.byteLength > 0) {
      config.description = description;
    }

    console.log('[Decoder] Configuring VideoDecoder with:', {
      codec: config.codec,
      codedWidth: config.codedWidth,
      codedHeight: config.codedHeight,
      hasDescription: !!config.description,
      descriptionLength: config.description ? (config.description as Uint8Array).byteLength : 0,
    });

    try {
      this.decoder.configure(config);
      console.log('[Decoder] VideoDecoder configured successfully. State:', this.decoder.state);
    } catch (err: any) {
      console.warn('[Decoder] Initial VideoDecoder configure failed:', err?.message || err, '. Attempting fallback without extradata description...');
      try {
        delete config.description;
        this.decoder.configure(config);
        console.log('[Decoder] VideoDecoder configured in fallback mode (no description). State:', this.decoder.state);
      } catch (fallbackErr: any) {
        console.warn('[Decoder] Fallback configure failed:', fallbackErr?.message || fallbackErr, '. Attempting normalized HEVC/AVC codec string...');
        try {
          if (normalizedCodec.startsWith('hvc1') || normalizedCodec.startsWith('hev1')) {
            config.codec = 'hvc1.1.6.L150.B0';
          }
          this.decoder.configure(config);
          console.log('[Decoder] VideoDecoder configured in normalized codec mode. State:', this.decoder.state);
        } catch (normErr: any) {
          console.error('[Decoder] All VideoDecoder configure attempts failed:', normErr);
          if (this.callbacks.onError) {
            this.callbacks.onError(normErr);
          }
        }
      }
    }
  }

  /**
   * Enqueues an EncodedVideoChunk into the WebCodecs decoder.
   */
  public decode(chunk: EncodedVideoChunk): void {
    if (this.decoder.state === 'configured') {
      this.decoder.decode(chunk);
    } else {
      console.warn('[Decoder] VideoDecoder is not in configured state:', this.decoder.state);
    }
  }

  /**
   * Output callback for VideoDecoder.
   * Hands off VideoFrame to custom onFrame pipeline processor or renders directly.
   */
  private async handleFrame(frame: VideoFrame): Promise<void> {
    this.frameCount++;
    const timestampUs = frame.timestamp;
    const frameIndex = this.frameCount;

    if (this.callbacks.onFrame) {
      try {
        await this.callbacks.onFrame(frame, frameIndex);
      } catch (err: any) {
        console.error('[Decoder] Error in custom frame processor:', err);
        // Guarantee closing frame if error occurs in callback
        try {
          frame.close();
        } catch {}
      }
    } else {
      // Default direct render to canvas
      if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
        this.canvas.width = frame.displayWidth;
        this.canvas.height = frame.displayHeight;
      }
      this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
      // CRITICAL: Call frame.close() immediately to avoid memory leaks
      frame.close();
    }

    if (this.callbacks.onFrameDecoded) {
      this.callbacks.onFrameDecoded(frameIndex, timestampUs);
    }
  }

  public async flush(): Promise<void> {
    if (this.decoder.state === 'configured') {
      await this.decoder.flush();
    }
  }

  public reset(): void {
    if (this.decoder.state !== 'unconfigured') {
      this.decoder.reset();
    }
    this.frameCount = 0;
  }

  public close(): void {
    if (this.decoder.state !== 'closed') {
      this.decoder.close();
    }
  }

  public getFrameCount(): number {
    return this.frameCount;
  }

  public getDecodeQueueSize(): number {
    return this.decoder?.decodeQueueSize || 0;
  }

  public getState(): CodecState {
    return this.decoder.state;
  }
}
