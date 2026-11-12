import { createFile, DataStream, type MP4BoxFile } from 'mp4box';
import { selectBestAudioTrack, type MuxerAudioCodec } from './audio';

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
  muxerCodec: MuxerAudioCodec | null;
  isMuxerSupported: boolean;
  numberOfChannels: number;
  sampleRate: number;
  timescale: number;
  bitrate: number;
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
  totalAudioTracks: number;
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
  private lastVideoSample: DemuxedSampleInfo | null = null;
  private lastVideoChunkTimestampUs = 0;
  private lastVideoChunkDurationUs = 0;

  constructor(callbacks: DemuxerCallbacks) {
    this.callbacks = callbacks;
    this.mp4file = createFile();
    this.setupMp4boxEvents();
  }

  private setupMp4boxEvents(): void {
    this.mp4file.onError = (err) => {
      console.error('[Demuxer] MP4Box error:', err);
      if (this.callbacks.onError) {
        this.callbacks.onError(typeof err === 'string' ? new Error(err) : err);
      }
    };

    this.mp4file.onReady = (info: MP4ArrayBufferInfo) => {
      const videoTrack = info.videoTracks[0] || info.tracks.find((t: MP4MediaTrack) => (t as any).type === 'video');
      if (!videoTrack) {
        const err = new Error('No video track found in the provided MP4 file.');
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

      // Locate best audio track for passthrough (prefers AAC/Opus and stereo over surround)
      const audioTracks =
        info.audioTracks.length > 0
          ? info.audioTracks
          : (info.tracks.filter((t: MP4MediaTrack) => (t as any).type === 'audio') as any[]);
      const bestAudio = selectBestAudioTrack(audioTracks);

      let audioInfo: DemuxerAudioInfo | undefined = undefined;
      if (bestAudio) {
        this.audioTimescale = bestAudio.track.timescale || 44100;
        if (bestAudio.isMuxerSupported) {
          this.selectedAudioTrackId = bestAudio.track.id;
        }
        audioInfo = {
          trackId: bestAudio.track.id,
          codec: bestAudio.track.codec,
          muxerCodec: bestAudio.muxerCodec,
          isMuxerSupported: bestAudio.isMuxerSupported,
          numberOfChannels: bestAudio.numberOfChannels,
          sampleRate: bestAudio.sampleRate,
          timescale: this.audioTimescale,
          bitrate: bestAudio.bitrate,
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
        totalAudioTracks: audioTracks.length,
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

          this.lastVideoSample = {
            cts: sampleTimestamp,
            duration: sample.duration || 0,
            timescale: this.timescale,
          };
          this.lastVideoChunkTimestampUs = timestampUs;
          this.lastVideoChunkDurationUs = durationUs;

          const chunk = new EncodedVideoChunk({
            type,
            timestamp: timestampUs,
            duration: durationUs,
            data: sample.data,
          });

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
    this.lastVideoSample = null;
    this.lastVideoChunkTimestampUs = 0;
    this.lastVideoChunkDurationUs = 0;
    this.sampleCount = 0;
    this.selectedVideoTrackId = null;
    this.selectedAudioTrackId = null;
    this.isCancelled = false;
  }

  /**
   * Streams the MP4 File in 4 MB chunks via file.slice() and appends to MP4Box.
   * Handles both fast-start (moov at start) and non-faststart (moov at end) containers without loading the entire file into RAM.
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

    const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
    let offset = 0;
    let bytesRead = 0;
    let backwardJumps = 0;
    const maxBackwardJumps = 8;

    console.log(`[Demuxer] Streaming file in 4 MB chunks (${file.size} bytes)...`);

    while (offset < file.size && !this.isCancelled) {
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const buffer = await file.slice(offset, end).arrayBuffer();
      if (this.isCancelled) return;

      (buffer as ArrayBuffer & { fileStart: number }).fileStart = offset;
      bytesRead = Math.min(file.size, bytesRead + buffer.byteLength);

      const nextOffset = this.mp4file.appendBuffer(buffer as ArrayBuffer & { fileStart: number });

      if (this.callbacks.onProgress) {
        this.callbacks.onProgress(bytesRead, file.size);
      }

      if (this.callbacks.checkBackpressure) {
        await this.callbacks.checkBackpressure();
      }

      if (typeof nextOffset === 'number' && nextOffset >= 0 && nextOffset < file.size) {
        if (nextOffset < offset) {
          backwardJumps++;
          if (backwardJumps > maxBackwardJumps) {
            offset = end;
          } else {
            offset = nextOffset;
          }
        } else if (nextOffset === offset) {
          // Guard against stalled offset
          offset = end;
        } else {
          offset = nextOffset;
        }
      } else {
        offset = end;
      }
    }

    if (!this.isCancelled) {
      console.log(`[Demuxer] File streaming complete. Total video samples emitted so far: ${this.sampleCount}. Flushing MP4Box...`);
      this.mp4file.flush();
      console.log(`[Demuxer] MP4Box flush complete. Total video samples emitted: ${this.sampleCount}.`);
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
    if (this.lastVideoSample) {
      const durationFromSamples =
        (this.lastVideoSample.cts + (this.lastVideoSample.duration || 0)) / (this.lastVideoSample.timescale || 1);
      if (durationFromSamples > 0) return durationFromSamples;
    }
    if (this.lastVideoChunkTimestampUs > 0 || this.lastVideoChunkDurationUs > 0) {
      const durationFromSamples = (this.lastVideoChunkTimestampUs + this.lastVideoChunkDurationUs) / 1_000_000;
      if (durationFromSamples > 0) return durationFromSamples;
    }
    if (this.durationSec > 0) return this.durationSec;
    return 30;
  }
}
