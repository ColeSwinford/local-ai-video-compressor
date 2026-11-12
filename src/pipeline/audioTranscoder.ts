/**
 * Maps container-specific audio codec IDs (MP4Box or Matroska) to WebCodecs AudioDecoder codec strings.
 */
export function mapToWebCodecsAudioCodec(rawCodec: string): string {
  const trimmed = rawCodec.trim();
  const upper = trimmed.toUpperCase();
  if (upper.startsWith('A_AAC')) return 'mp4a.40.2';
  if (upper === 'A_OPUS' || upper === 'OPUS') return 'opus';
  if (upper === 'A_VORBIS' || upper === 'VORBIS') return 'vorbis';
  if (upper === 'A_FLAC' || upper === 'FLAC') return 'flac';
  if (upper === 'A_MPEG/L3' || upper === 'MP3') return 'mp3';
  if (upper === 'A_AC3' || upper === 'AC-3') return 'ac-3';
  if (upper === 'A_EAC3' || upper === 'EC-3') return 'ec-3';
  return trimmed;
}

/**
 * Downmixes 1..N planar Float32 audio channels into a contiguous 2-channel f32-planar buffer.
 */
export function downmixChannelsToStereo(channels: Float32Array[], numberOfFrames: number): Float32Array {
  const out = new Float32Array(numberOfFrames * 2);
  const left = out.subarray(0, numberOfFrames);
  const right = out.subarray(numberOfFrames, numberOfFrames * 2);

  if (channels.length === 0) return out;
  if (channels.length === 1) {
    left.set(channels[0].subarray(0, numberOfFrames));
    right.set(channels[0].subarray(0, numberOfFrames));
    return out;
  }

  const chL = channels[0];
  const chR = channels[1];
  if (channels.length === 2) {
    left.set(chL.subarray(0, numberOfFrames));
    right.set(chR.subarray(0, numberOfFrames));
    return out;
  }

  // ITU-R surround downmix (5.1 / 7.1 -> Stereo): L + 0.707*C + 0.707*Ls, R + 0.707*C + 0.707*Rs
  const chC = channels[2];
  const chLs = channels.length >= 5 ? channels[4] : undefined;
  const chRs = channels.length >= 6 ? channels[5] : undefined;
  const invSqrt2 = 0.70710678;

  for (let i = 0; i < numberOfFrames; i++) {
    let l = chL[i] + chC[i] * invSqrt2;
    let r = chR[i] + chC[i] * invSqrt2;
    if (chLs) l += chLs[i] * invSqrt2;
    if (chRs) r += chRs[i] * invSqrt2;
    left[i] = l > 1 ? 1 : l < -1 ? -1 : l;
    right[i] = r > 1 ? 1 : r < -1 ? -1 : r;
  }

  return out;
}

/**
 * Resamples planar Float32 audio channels from srcSampleRate to dstSampleRate using linear interpolation.
 */
export function resamplePlanarChannels(
  planarData: Float32Array,
  numberOfChannels: number,
  srcFrames: number,
  srcSampleRate: number,
  dstSampleRate: number,
): { data: Float32Array; numberOfFrames: number } {
  if (srcSampleRate === dstSampleRate || srcFrames === 0) {
    return { data: planarData, numberOfFrames: srcFrames };
  }

  const dstFrames = Math.max(1, Math.round((srcFrames * dstSampleRate) / srcSampleRate));
  const out = new Float32Array(dstFrames * numberOfChannels);
  const step = srcSampleRate / dstSampleRate;

  for (let c = 0; c < numberOfChannels; c++) {
    const srcOffset = c * srcFrames;
    const dstOffset = c * dstFrames;
    for (let i = 0; i < dstFrames; i++) {
      const pos = i * step;
      const idx = Math.floor(pos);
      if (idx >= srcFrames - 1) {
        out[dstOffset + i] = planarData[srcOffset + srcFrames - 1];
      } else {
        const frac = pos - idx;
        const s0 = planarData[srcOffset + idx];
        const s1 = planarData[srcOffset + idx + 1];
        out[dstOffset + i] = s0 + (s1 - s0) * frac;
      }
    }
  }

  return { data: out, numberOfFrames: dstFrames };
}

export interface AudioTranscoderSourceConfig {
  codec: string;
  numberOfChannels: number;
  sampleRate: number;
  description?: Uint8Array;
}

export interface AudioTranscoderInitResult {
  supported: boolean;
  outputCodec?: 'aac' | 'opus';
  outputChannels?: number;
  actualBitrate?: number;
  reason?: string;
}

/**
 * WebCodecs AudioDecoder -> Stereo Downmix -> AudioEncoder (AAC-LC / Opus fallback) transcoder.
 */
export class AudioTranscoder {
  private decoder: AudioDecoder | null = null;
  private encoder: AudioEncoder | null = null;
  private isErrored = false;
  private encodedChunkCount = 0;

  public async init(
    source: AudioTranscoderSourceConfig,
    targetBitrate: number,
    onEncodedChunk: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void,
    onError?: (msg: string) => void,
    preferredCodec: 'aac' | 'opus' = 'opus',
  ): Promise<AudioTranscoderInitResult> {
    if (typeof AudioDecoder === 'undefined' || typeof AudioEncoder === 'undefined') {
      return { supported: false, reason: 'WebCodecs AudioDecoder/AudioEncoder not supported in this browser.' };
    }

    const decoderCodec = mapToWebCodecsAudioCodec(source.codec);
    const decoderConfig: AudioDecoderConfig = {
      codec: decoderCodec,
      numberOfChannels: source.numberOfChannels,
      sampleRate: source.sampleRate,
      ...(source.description && source.description.byteLength > 0 ? { description: source.description } : {}),
    };

    try {
      const decSupport = await AudioDecoder.isConfigSupported(decoderConfig);
      if (!decSupport.supported) {
        return {
          supported: false,
          reason: `Browser cannot decode audio codec "${source.codec}" (${decoderCodec}).`,
        };
      }
    } catch {
      return {
        supported: false,
        reason: `Browser cannot decode audio codec "${source.codec}".`,
      };
    }

    const sampleRate = source.sampleRate || 48000;
    const targetChannels = source.numberOfChannels === 1 ? 1 : 2;
    const aacBitrateCandidates = Array.from(new Set([targetBitrate, 96_000, 128_000]));
    const aacCandidates = aacBitrateCandidates.map((bps) => ({
      muxerCodec: 'aac' as const,
      config: {
        codec: 'mp4a.40.2',
        numberOfChannels: targetChannels,
        sampleRate,
        bitrate: bps,
        aac: { format: 'aac' },
      } as AudioEncoderConfig,
    }));
    const opusCandidate = {
      muxerCodec: 'opus' as const,
      config: {
        codec: 'opus',
        numberOfChannels: targetChannels,
        sampleRate: 48000,
        bitrate: targetBitrate,
      } as AudioEncoderConfig,
    };

    const encoderCandidates =
      preferredCodec === 'opus' ? [opusCandidate, ...aacCandidates] : [...aacCandidates, opusCandidate];

    let chosen: { muxerCodec: 'aac' | 'opus'; config: AudioEncoderConfig } | null = null;
    for (const candidate of encoderCandidates) {
      try {
        const encSupport = await AudioEncoder.isConfigSupported(candidate.config);
        if (encSupport.supported) {
          chosen = candidate;
          break;
        }
      } catch {
        // Try next candidate
      }
    }

    if (!chosen) {
      return { supported: false, reason: 'Browser does not support AAC or Opus AudioEncoder.' };
    }

    const encoderConfig = chosen.config;

    this.encoder = new AudioEncoder({
      output: (chunk, meta) => {
        this.encodedChunkCount++;
        onEncodedChunk(chunk, meta);
      },
      error: (err) => {
        console.warn('[AudioTranscoder] AudioEncoder error:', err);
        this.isErrored = true;
        if (onError) onError(`AudioEncoder error: ${err?.message || err}`);
      },
    });
    this.encoder.configure(encoderConfig);

    const targetSampleRate = encoderConfig.sampleRate;

    this.decoder = new AudioDecoder({
      output: (audioData: AudioData) => {
        try {
          if (this.isErrored || !this.encoder || this.encoder.state !== 'configured') return;

          if (
            audioData.numberOfChannels === targetChannels &&
            audioData.sampleRate === targetSampleRate &&
            audioData.format === 'f32-planar'
          ) {
            this.encoder.encode(audioData);
            return;
          }

          const numChannels = audioData.numberOfChannels;
          const numFrames = audioData.numberOfFrames;
          const channels: Float32Array[] = [];
          for (let c = 0; c < numChannels; c++) {
            const plane = new Float32Array(numFrames);
            audioData.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
            channels.push(plane);
          }

          const downmixed =
            targetChannels === 1 ? channels[0] : downmixChannelsToStereo(channels, numFrames);
          const resampled = resamplePlanarChannels(
            downmixed,
            targetChannels,
            numFrames,
            audioData.sampleRate,
            targetSampleRate,
          );
          const outAudioData = new AudioData({
            format: 'f32-planar',
            sampleRate: targetSampleRate,
            numberOfFrames: resampled.numberOfFrames,
            numberOfChannels: targetChannels,
            timestamp: audioData.timestamp,
            data: resampled.data as BufferSource,
          });
          try {
            this.encoder.encode(outAudioData);
          } finally {
            outAudioData.close();
          }
        } catch (err) {
          console.warn('[AudioTranscoder] Audio frame transcode error:', err);
        } finally {
          audioData.close();
        }
      },
      error: (err) => {
        console.warn('[AudioTranscoder] AudioDecoder error:', err);
        this.isErrored = true;
        if (onError) onError(`AudioDecoder error: ${err?.message || err}`);
      },
    });
    this.decoder.configure(decoderConfig);

    return {
      supported: true,
      outputCodec: chosen.muxerCodec,
      outputChannels: targetChannels,
      actualBitrate: encoderConfig.bitrate,
    };
  }

  public decode(chunk: EncodedAudioChunk): void {
    if (this.isErrored || !this.decoder || this.decoder.state !== 'configured') return;
    try {
      this.decoder.decode(chunk);
    } catch {
      // Ignore individual corrupt audio frames
    }
  }

  public getEncodedChunkCount(): number {
    return this.encodedChunkCount;
  }

  public async flush(): Promise<void> {
    try {
      if (this.decoder && this.decoder.state === 'configured') {
        await this.decoder.flush();
      }
      if (this.encoder && this.encoder.state === 'configured') {
        await this.encoder.flush();
      }
    } catch (err) {
      console.warn('[AudioTranscoder] Flush error:', err);
    }
  }

  public close(): void {
    try {
      if (this.decoder && this.decoder.state !== 'closed') {
        this.decoder.close();
      }
    } catch {}
    try {
      if (this.encoder && this.encoder.state !== 'closed') {
        this.encoder.close();
      }
    } catch {}
    this.decoder = null;
    this.encoder = null;
  }
}
