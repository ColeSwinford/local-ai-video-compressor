import { createFile, DataStream, type MP4BoxFile } from 'mp4box';

export interface MP4MediaTrack {
  id: number;
  created: Date;
  modified: Date;
  movie_duration: number;
  layer: number;
  alternate_group: number;
  volume: number;
  track_width: number;
  track_height: number;
  timescale: number;
  duration: number;
  bitrate: number;
  codec: string;
  language: string;
  nb_samples: number;
}

export interface MP4VideoTrack extends MP4MediaTrack {
  video: {
    width: number;
    height: number;
  };
}

export interface MP4AudioTrack extends MP4MediaTrack {
  audio: {
    sample_rate: number;
    channel_count: number;
  };
}

export interface MP4ArrayBufferInfo {
  duration: number;
  timescale: number;
  isFragmented: boolean;
  isProgressive: boolean;
  hasIOD: boolean;
  brands: string[];
  created: Date;
  modified: Date;
  tracks: MP4MediaTrack[];
  videoTracks: MP4VideoTrack[];
  audioTracks: MP4AudioTrack[];
  subtitleTracks: MP4MediaTrack[];
  metadataTracks: MP4MediaTrack[];
}

export interface MP4Sample {
  track_id: number;
  description: any;
  is_rap: boolean;
  is_sync: boolean;
  has_redundancy: boolean;
  degradation_priority: number;
  depends_on: number;
  is_depended_on: number;
  cts: number;
  dts: number;
  duration: number;
  size: number;
  data: Uint8Array;
  offset: number;
}

export interface DemuxerAudioInfo {
  trackId: number;
  codec: string;
  numberOfChannels: number;
  sampleRate: number;
  timescale: number;
}

export interface DemuxerReadyInfo {
  trackId: number;
  codec: string;
  width: number;
  height: number;
  targetWidth: number;
  targetHeight: number;
  isDownscaled: boolean;
  duration: number;
  timescale: number;
  nbSamples: number;
  description?: Uint8Array;
  audioInfo?: DemuxerAudioInfo;
}

export interface DemuxerCallbacks {
  onReady: (info: DemuxerReadyInfo) => void;
  onSample: (chunk: EncodedVideoChunk) => void;
  onAudioSample?: (chunk: EncodedAudioChunk) => void;
  onProgress?: (bytesRead: number, totalBytes: number) => void;
  checkBackpressure?: () => Promise<void>;
  onError?: (error: Error | string) => void;
  onComplete?: () => void;
}

/**
 * Extracts the codec extra data (SPS/PPS, avcC/hvcC/vpcC/av1C box payload) from mp4box.js track entry.
 */
function extractTrackDescription(mp4file: MP4BoxFile, trackId: number): Uint8Array | undefined {
  try {
    const track = mp4file.getTrackById(trackId);
    if (!track || !track.mdia?.minf?.stbl?.stsd?.entries?.length) {
      return undefined;
    }

    const entry = track.mdia.minf.stbl.stsd.entries[0];
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (!box) {
      return undefined;
    }

    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    box.write(stream);

    // Box serialization writes 4 bytes length + 4 bytes box type header.
    // WebCodecs VideoDecoder description parameter expects the raw payload without the 8-byte header.
    if (stream.position > 8) {
      return new Uint8Array(stream.buffer.slice(8, stream.position));
    }
  } catch (err) {
    console.warn('[Demuxer] Could not extract extradata description:', err);
  }
  return undefined;
}

export interface DemuxedSampleInfo {
  cts: number;
  duration: number;
  timescale: number;
}

export class Demuxer {
  private mp4file: MP4BoxFile;
  private callbacks: DemuxerCallbacks;
  private isCancelled = false;
  private timescale = 1000;
  private audioTimescale = 44100;
  private selectedVideoTrackId: number | null = null;
  private selectedAudioTrackId: number | null = null;
  private sampleCount = 0;
  private audioTrackSize = 0;
  private durationSec = 0;
  private videoSamples: EncodedVideoChunk[] = [];
  private audioSamples: EncodedAudioChunk[] = [];
  private rawVideoSamples: DemuxedSampleInfo[] = [];
  private demuxError: Error | null = null;

  constructor(callbacks: DemuxerCallbacks) {
    this.callbacks = callbacks;
    this.mp4file = createFile();
    this.setupMp4boxEvents();
  }

  private setupMp4boxEvents(): void {
    this.mp4file.onError = (err) => {
      console.error('[Demuxer] MP4Box error:', err);
      const errorObj = typeof err === 'string' ? new Error(err) : err;
      this.demuxError = errorObj;
      if (this.callbacks.onError) {
        this.callbacks.onError(errorObj);
      }
    };

    this.mp4file.onReady = (info: MP4ArrayBufferInfo) => {
      const videoTrack = info.videoTracks[0] || info.tracks.find((t: MP4MediaTrack) => (t as any).type === 'video');
      if (!videoTrack) {
        const err = new Error('No video track found in the provided MP4 file.');
        this.demuxError = err;
        if (this.callbacks.onError) this.callbacks.onError(err);
        return;
      }

      this.selectedVideoTrackId = videoTrack.id;
      this.timescale = videoTrack.timescale || info.timescale || 1000;
      const trackDuration = videoTrack.duration || info.duration || 0;
      const trackTimescale = videoTrack.timescale || info.timescale || 1;
      this.durationSec = trackDuration / trackTimescale;
      const description = extractTrackDescription(this.mp4file, videoTrack.id);

      const rawWidth = videoTrack.video?.width || videoTrack.track_width || 1280;
      const rawHeight = videoTrack.video?.height || videoTrack.track_height || 720;

      let targetWidth = Math.floor(rawWidth / 2) * 2;
      let targetHeight = Math.floor(rawHeight / 2) * 2;
      let isDownscaled = false;

      // Dynamic 1080p resolution cap rule for 4K inputs (maintains exact aspect ratio with even dimensions)
      if (rawWidth > 1920 || rawHeight > 1080) {
        const scale = Math.min(1920 / rawWidth, 1080 / rawHeight);
        targetWidth = Math.floor((rawWidth * scale) / 2) * 2;
        targetHeight = Math.floor((rawHeight * scale) / 2) * 2;
        isDownscaled = true;
      }

      if (targetWidth < 2) targetWidth = 2;
      if (targetHeight < 2) targetHeight = 2;

      // Locate optional audio track for passthrough
      let audioInfo: DemuxerAudioInfo | undefined = undefined;
      const audioTrack = info.audioTracks[0] || info.tracks.find((t: MP4MediaTrack) => (t as any).type === 'audio');
      if (audioTrack) {
        this.selectedAudioTrackId = audioTrack.id;
        this.audioTimescale = audioTrack.timescale || 44100;
        audioInfo = {
          trackId: audioTrack.id,
          codec: audioTrack.codec,
          numberOfChannels: audioTrack.audio?.channel_count || (audioTrack as any).channel_count || 2,
          sampleRate: audioTrack.audio?.sample_rate || (audioTrack as any).sample_rate || 44100,
          timescale: this.audioTimescale,
        };
      }

      const readyInfo: DemuxerReadyInfo = {
        trackId: videoTrack.id,
        codec: videoTrack.codec,
        width: rawWidth,
        height: rawHeight,
        targetWidth,
        targetHeight,
        isDownscaled,
        duration: videoTrack.duration,
        timescale: this.timescale,
        nbSamples: videoTrack.nb_samples,
        description,
        audioInfo,
      };

      console.log('[Demuxer] Track ready:', readyInfo);
      this.callbacks.onReady(readyInfo);

      // 1. Set extraction options for Video Track with nbSamples: 1 for immediate emission
      this.mp4file.setExtractionOptions(videoTrack.id, null, { nbSamples: 1 });

      // 2. Set extraction options for Audio Track separately if present
      if (this.selectedAudioTrackId !== null) {
        this.mp4file.setExtractionOptions(this.selectedAudioTrackId, null, { nbSamples: 1 });
      }

      // 3. Call start() ONLY AFTER extraction options have been set for both tracks
      this.mp4file.start();
    };

    this.mp4file.onSamples = async (trackId: number, _user: any, samples: MP4Sample[]) => {
      // 1. Process Video Samples with Async Backpressure Throttling
      if (this.selectedVideoTrackId !== null && trackId === this.selectedVideoTrackId) {
        for (let i = 0; i < samples.length; i++) {
          if (this.isCancelled) break;
          const sample = samples[i];

          this.sampleCount++;
          const isKeyframe = sample.is_sync;
          const type: EncodedVideoChunkType = isKeyframe ? 'key' : 'delta';

          const sampleTimestamp = sample.cts !== undefined ? sample.cts : sample.dts;
          const timestampUs = Math.round((sampleTimestamp * 1_000_000) / this.timescale);
          const durationUs = Math.round((sample.duration * 1_000_000) / this.timescale);

          this.rawVideoSamples.push({
            cts: sampleTimestamp,
            duration: sample.duration || 0,
            timescale: this.timescale,
          });

          const chunk = new EncodedVideoChunk({
            type,
            timestamp: timestampUs,
            duration: durationUs,
            data: sample.data,
          });

          this.videoSamples.push(chunk);
          this.callbacks.onSample(chunk);

          // Throttling: Pause demuxer extraction after every 10 video samples if decode/encode queues back up
          if (this.sampleCount % 10 === 0 && this.callbacks.checkBackpressure) {
            await this.callbacks.checkBackpressure();
          }
        }
      }

      // 2. Process Audio Samples (Audio Passthrough)
      if (this.selectedAudioTrackId !== null && trackId === this.selectedAudioTrackId) {
        for (const sample of samples) {
          if (this.isCancelled) break;
          this.audioTrackSize += sample.size || sample.data?.byteLength || 0;

          const sampleTimestamp = sample.cts !== undefined ? sample.cts : sample.dts;
          const timestampUs = Math.round((sampleTimestamp * 1_000_000) / this.audioTimescale);
          const durationUs = Math.round((sample.duration * 1_000_000) / this.audioTimescale);

          const audioChunk = new EncodedAudioChunk({
            type: 'key',
            timestamp: timestampUs,
            duration: durationUs,
            data: sample.data,
          });

          this.audioSamples.push(audioChunk);
          if (this.callbacks.onAudioSample) {
            this.callbacks.onAudioSample(audioChunk);
          }
        }
      }
    };
  }

  /**
   * Resets internal accumulators and track state before demuxing runs.
   */
  public reset(): void {
    this.audioTrackSize = 0;
    this.durationSec = 0;
    this.videoSamples = [];
    this.audioSamples = [];
    this.rawVideoSamples = [];
    this.sampleCount = 0;
    this.selectedVideoTrackId = null;
    this.selectedAudioTrackId = null;
    this.isCancelled = false;
    this.demuxError = null;
  }

  /**
   * Alias for demuxFile for API consistency.
   */
  public async demux(file: File): Promise<void> {
    return this.demuxFile(file);
  }

  /**
   * Reads full MP4 File ArrayBuffer and appends to MP4Box.
   * Guarantees moov parsing and complete sample extraction across all container layouts (including QuickTime MOVs).
   */
  public async demuxFile(file: File): Promise<void> {
    this.reset();

    // Re-create brand new MP4BoxFile instance to guarantee Pass 2 starts with zero lingering state from Pass 1
    try {
      this.mp4file.flush();
      this.mp4file.stop();
    } catch {
      // Ignore cleanup error if already stopped
    }
    this.mp4file = createFile();
    this.setupMp4boxEvents();

    if (this.callbacks.onProgress) {
      this.callbacks.onProgress(0, file.size);
    }

    console.log(`[Demuxer] Reading full file buffer (${file.size} bytes)...`);
    const buffer = await file.arrayBuffer();
    if (this.isCancelled) return;

    (buffer as any).fileStart = 0;

    if (this.callbacks.onProgress) {
      this.callbacks.onProgress(file.size, file.size);
    }

    console.log(`[Demuxer] Appending full buffer (${buffer.byteLength} bytes) to MP4Box...`);
    this.mp4file.appendBuffer(buffer as any);

    if (this.demuxError) {
      throw this.demuxError;
    }

    if (!this.isCancelled) {
      console.log(`[Demuxer] File buffer appended. Total video samples emitted so far: ${this.sampleCount}. Flushing MP4Box...`);
      this.mp4file.flush();
      console.log(`[Demuxer] MP4Box flush complete. Total video samples emitted: ${this.sampleCount}.`);
      if (this.demuxError) {
        throw this.demuxError;
      }
      if (this.callbacks.onComplete) {
        this.callbacks.onComplete();
      }
    }
  }

  public cancel(): void {
    this.isCancelled = true;
    try {
      this.mp4file.flush();
      this.mp4file.stop();
    } catch {
      // Ignore cleanup error
    }
  }

  public getSampleCount(): number {
    return this.sampleCount;
  }

  public getAudioTrackSize(): number {
    return this.audioTrackSize;
  }

  public getDuration(): number {
    return this.durationSec;
  }

  public getExactDuration(): number {
    if (this.rawVideoSamples.length > 0) {
      const lastSample = this.rawVideoSamples[this.rawVideoSamples.length - 1];
      const durationFromSamples = (lastSample.cts + (lastSample.duration || 0)) / (lastSample.timescale || 1);
      if (durationFromSamples > 0) return durationFromSamples;
    }
    if (this.videoSamples.length > 0) {
      const lastSample = this.videoSamples[this.videoSamples.length - 1];
      const durationFromSamples = (lastSample.timestamp + (lastSample.duration || 0)) / 1_000_000;
      if (durationFromSamples > 0) return durationFromSamples;
    }
    if (this.durationSec > 0) return this.durationSec;
    return 30;
  }

  public getVideoSamples(): EncodedVideoChunk[] {
    return this.videoSamples;
  }

  public getAudioSamples(): EncodedAudioChunk[] {
    return this.audioSamples;
  }
}
