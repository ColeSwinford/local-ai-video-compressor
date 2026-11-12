import type { DemuxerAudioInfo, DemuxerCallbacks, DemuxerReadyInfo } from './demuxer';
import type { MuxerAudioCodec } from './audio';

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMESCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_VIDEO = 0xe0;
const ID_PIXEL_WIDTH = 0xb0;
const ID_PIXEL_HEIGHT = 0xba;
const ID_AUDIO = 0xe1;
const ID_SAMPLING_FREQ = 0xb5;
const ID_CHANNELS = 0x9f;
const ID_CLUSTER = 0x1f43b675;
const ID_CLUSTER_TIMESTAMP = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_BLOCK_DURATION = 0x9b;

export interface EbmlVintResult {
  value: number;
  length: number;
  isUnknown: boolean;
}

/**
 * Reads an EBML variable-length integer (VINT) from `buf` at `offset`.
 * When `maskLeadingBit` is false, preserves the leading marker bit (used for Element IDs).
 */
export function readEbmlVint(
  buf: Uint8Array,
  offset: number,
  maskLeadingBit = true,
): EbmlVintResult | null {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;

  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || offset + length > buf.length) return null;

  let value = maskLeadingBit ? first & ~mask : first;
  let allOnes = (first & ~mask) === mask - 1;

  for (let i = 1; i < length; i++) {
    const byte = buf[offset + i];
    if (byte !== 0xff) allOnes = false;
    value = value * 256 + byte;
  }

  return {
    value,
    length,
    isUnknown: maskLeadingBit && allOnes,
  };
}

function readUintBE(buf: Uint8Array, offset: number, length: number): number {
  let val = 0;
  for (let i = 0; i < length; i++) {
    val = val * 256 + buf[offset + i];
  }
  return val;
}

function readFloatBE(buf: Uint8Array, offset: number, length: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, length);
  if (length === 4) return view.getFloat32(0, false);
  if (length === 8) return view.getFloat64(0, false);
  return 0;
}

function readAscii(buf: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    const c = buf[offset + i];
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

/**
 * Maps a Matroska video CodecID + optional CodecPrivate to a WebCodecs VideoDecoder codec string.
 */
export function mapMatroskaVideoCodec(codecId: string, codecPrivate?: Uint8Array): string {
  const id = codecId.trim();
  if (id === 'V_MPEG4/ISO/AVC') {
    if (codecPrivate && codecPrivate.length >= 4 && codecPrivate[0] === 1) {
      const p = codecPrivate[1].toString(16).padStart(2, '0');
      const c = codecPrivate[2].toString(16).padStart(2, '0');
      const l = codecPrivate[3].toString(16).padStart(2, '0');
      return `avc1.${p}${c}${l}`;
    }
    return 'avc1.64002a';
  }
  if (id === 'V_MPEGH/ISO/HEVC') {
    if (codecPrivate && codecPrivate.length >= 13) {
      const profileSpace = (codecPrivate[1] >> 6) & 0x03;
      const tierFlag = (codecPrivate[1] >> 5) & 0x01;
      const profileIdc = codecPrivate[1] & 0x1f;
      const levelIdc = codecPrivate[12];
      const spacePrefix = ['', 'A', 'B', 'C'][profileSpace] || '';
      const tierChar = tierFlag ? 'H' : 'L';
      return `hvc1.${spacePrefix}${profileIdc}.4.${tierChar}${levelIdc}.B0`;
    }
    return 'hvc1.1.6.L150.B0';
  }
  if (id === 'V_VP8') return 'vp8';
  if (id === 'V_VP9') return 'vp09.00.41.08';
  if (id === 'V_AV1') return 'av01.0.08M.08';
  return id;
}

/**
 * Maps a Matroska audio CodecID to an mp4-muxer compatible codec, or null if unsupported.
 */
export function mapMatroskaAudioCodec(codecId: string): MuxerAudioCodec | null {
  const id = codecId.trim().toUpperCase();
  if (id.startsWith('A_AAC')) return 'aac';
  if (id === 'A_OPUS') return 'opus';
  return null;
}

export interface ParsedBlockHeader {
  trackNumber: number;
  relativeTimestamp: number;
  isKeyframe: boolean;
  lacing: number;
  payloadOffset: number;
}

/**
 * Parses a Matroska SimpleBlock or Block header.
 */
export function parseBlockHeader(data: Uint8Array, isSimpleBlock: boolean): ParsedBlockHeader | null {
  const trackVint = readEbmlVint(data, 0, true);
  if (!trackVint) return null;
  const headerEnd = trackVint.length + 3;
  if (data.length < headerEnd) return null;

  const relTs = (data[trackVint.length] << 8) | data[trackVint.length + 1];
  const signedRelTs = relTs >= 0x8000 ? relTs - 0x10000 : relTs;
  const flags = data[trackVint.length + 2];
  const lacing = (flags >> 1) & 0x03;
  const isKeyframe = isSimpleBlock ? (flags & 0x80) !== 0 : false;

  return {
    trackNumber: trackVint.value,
    relativeTimestamp: signedRelTs,
    isKeyframe,
    lacing,
    payloadOffset: headerEnd,
  };
}

function splitLacedFrames(data: Uint8Array, payloadOffset: number, lacing: number): Uint8Array[] {
  if (lacing === 0) {
    return [data.subarray(payloadOffset)];
  }
  if (payloadOffset >= data.length) return [];

  const frameCount = data[payloadOffset] + 1;
  let cursor = payloadOffset + 1;

  if (lacing === 1) {
    // Xiph lacing
    const sizes: number[] = [];
    let totalExplicit = 0;
    for (let i = 0; i < frameCount - 1; i++) {
      let size = 0;
      while (cursor < data.length) {
        const b = data[cursor++];
        size += b;
        if (b < 255) break;
      }
      sizes.push(size);
      totalExplicit += size;
    }
    sizes.push(Math.max(0, data.length - cursor - totalExplicit));
    const frames: Uint8Array[] = [];
    for (const s of sizes) {
      frames.push(data.subarray(cursor, cursor + s));
      cursor += s;
    }
    return frames;
  }

  if (lacing === 2) {
    // Fixed-size lacing
    const remaining = data.length - cursor;
    const frameSize = Math.floor(remaining / frameCount);
    const frames: Uint8Array[] = [];
    for (let i = 0; i < frameCount; i++) {
      frames.push(data.subarray(cursor, cursor + frameSize));
      cursor += frameSize;
    }
    return frames;
  }

  // EBML lacing (lacing === 3)
  const sizes: number[] = [];
  const firstSizeVint = readEbmlVint(data, cursor, true);
  if (!firstSizeVint) return [data.subarray(payloadOffset)];
  sizes.push(firstSizeVint.value);
  cursor += firstSizeVint.length;
  let prevSize = firstSizeVint.value;
  let totalExplicit = prevSize;

  for (let i = 1; i < frameCount - 1; i++) {
    const deltaVint = readEbmlVint(data, cursor, true);
    if (!deltaVint) break;
    cursor += deltaVint.length;
    const bias = Math.pow(2, deltaVint.length * 7 - 1) - 1;
    const nextSize = prevSize + (deltaVint.value - bias);
    sizes.push(nextSize);
    prevSize = nextSize;
    totalExplicit += nextSize;
  }
  sizes.push(Math.max(0, data.length - cursor - totalExplicit));

  const frames: Uint8Array[] = [];
  for (const s of sizes) {
    frames.push(data.subarray(cursor, cursor + s));
    cursor += s;
  }
  return frames;
}

interface MkvTrack {
  trackNumber: number;
  trackType: number;
  codecId: string;
  codecPrivate?: Uint8Array;
  width: number;
  height: number;
  sampleRate: number;
  channels: number;
}

/**
 * Streaming Matroska / WebM (.mkv / .webm) demuxer using 4 MB file.slice() reads.
 * Emits WebCodecs EncodedVideoChunk and EncodedAudioChunk matching the Demuxer interface.
 */
export class MkvDemuxer {
  private callbacks: DemuxerCallbacks;
  private isCancelled = false;
  private sampleCount = 0;
  private audioTrackSize = 0;
  private durationSec = 0;
  private timestampScaleNs = 1_000_000;
  private tracks: MkvTrack[] = [];
  private selectedVideoTrack: MkvTrack | null = null;
  private selectedAudioTrack: MkvTrack | null = null;
  private readyEmitted = false;
  private currentClusterTs = 0;
  private lastVideoTimestampUs = 0;

  constructor(callbacks: DemuxerCallbacks) {
    this.callbacks = callbacks;
  }

  public cancel(): void {
    this.isCancelled = true;
  }

  public getSampleCount(): number {
    return this.sampleCount;
  }

  public getAudioTrackSize(): number {
    return this.audioTrackSize;
  }

  public getExactDuration(): number {
    if (this.lastVideoTimestampUs > 0) {
      return this.lastVideoTimestampUs / 1_000_000;
    }
    return this.durationSec > 0 ? this.durationSec : 30;
  }

  private reset(): void {
    this.isCancelled = false;
    this.sampleCount = 0;
    this.audioTrackSize = 0;
    this.durationSec = 0;
    this.timestampScaleNs = 1_000_000;
    this.tracks = [];
    this.selectedVideoTrack = null;
    this.selectedAudioTrack = null;
    this.readyEmitted = false;
    this.currentClusterTs = 0;
    this.lastVideoTimestampUs = 0;
  }

  public async demuxFile(file: File): Promise<void> {
    this.reset();

    if (this.callbacks.onProgress) {
      this.callbacks.onProgress(0, file.size);
    }

    const CHUNK_SIZE = 4 * 1024 * 1024;
    let fileOffset = 0;
    let tail = new Uint8Array(0);
    let inSegment = false;
    let inCluster = false;
    let clusterEndGlobal = Infinity;

    while ((fileOffset < file.size || tail.length > 0) && !this.isCancelled) {
      // Top up rolling buffer if < 2 MB remains and file still has bytes
      if (tail.length < 2 * 1024 * 1024 && fileOffset < file.size) {
        const end = Math.min(fileOffset + CHUNK_SIZE, file.size);
        const sliceBuf = new Uint8Array(await file.slice(fileOffset, end).arrayBuffer());
        if (this.isCancelled) return;

        fileOffset = end;
        const merged = new Uint8Array(tail.length + sliceBuf.length);
        merged.set(tail, 0);
        merged.set(sliceBuf, tail.length);
        tail = merged;

        if (this.callbacks.onProgress) {
          this.callbacks.onProgress(fileOffset, file.size);
        }
      }

      let cursor = 0;
      let madeProgress = false;

      while (cursor < tail.length && !this.isCancelled) {
        const idVint = readEbmlVint(tail, cursor, false);
        if (!idVint) break;
        const sizeVint = readEbmlVint(tail, cursor + idVint.length, true);
        if (!sizeVint) break;

        const headerLen = idVint.length + sizeVint.length;
        const elemId = idVint.value;
        const elemSize = sizeVint.value;

        // Enter master containers that can be huge / unknown-size
        if (elemId === ID_SEGMENT) {
          inSegment = true;
          cursor += headerLen;
          madeProgress = true;
          continue;
        }

        if (elemId === ID_CLUSTER) {
          if (!this.readyEmitted) {
            this.emitReady();
          }
          inCluster = true;
          clusterEndGlobal = sizeVint.isUnknown ? Infinity : elemSize;
          void clusterEndGlobal;
          cursor += headerLen;
          madeProgress = true;
          continue;
        }

        // Wait for more bytes if a leaf/small master element isn't fully in `tail`
        if (sizeVint.isUnknown) {
          cursor += headerLen;
          madeProgress = true;
          continue;
        }

        if (cursor + headerLen + elemSize > tail.length) {
          // Element is larger than current buffer; if we still have file bytes, read more.
          // If it's a huge non-Cluster/non-Segment element (unlikely) at EOF, stop.
          if (fileOffset < file.size) {
            break;
          }
          cursor = tail.length;
          break;
        }

        const payloadStart = cursor + headerLen;
        const payload = tail.subarray(payloadStart, payloadStart + elemSize);

        if (elemId === ID_EBML) {
          // Skip EBML header
        } else if (inSegment && elemId === ID_INFO) {
          this.parseInfo(payload);
        } else if (inSegment && elemId === ID_TRACKS) {
          this.parseTracks(payload);
        } else if (inCluster && elemId === ID_CLUSTER_TIMESTAMP) {
          this.currentClusterTs = readUintBE(payload, 0, payload.length);
        } else if (inCluster && elemId === ID_SIMPLE_BLOCK) {
          await this.handleBlock(payload, true, 0);
        } else if (inCluster && elemId === ID_BLOCK_GROUP) {
          await this.parseBlockGroup(payload);
        }

        cursor = payloadStart + elemSize;
        madeProgress = true;
      }

      if (cursor > 0) {
        tail = tail.subarray(cursor);
      } else if (!madeProgress && fileOffset >= file.size) {
        break;
      } else if (!madeProgress && tail.length > 32 * 1024 * 1024) {
        // Safety valve: avoid unbounded buffer growth on corrupt element sizes
        throw new Error('Malformed MKV/WebM EBML structure exceeded 32 MB element buffer.');
      }
    }

    if (!this.readyEmitted && !this.isCancelled) {
      this.emitReady();
    }

    if (!this.isCancelled && this.callbacks.onComplete) {
      this.callbacks.onComplete();
    }
  }

  private parseInfo(buf: Uint8Array): void {
    let cursor = 0;
    let rawDuration = 0;
    while (cursor < buf.length) {
      const idVint = readEbmlVint(buf, cursor, false);
      if (!idVint) break;
      const sizeVint = readEbmlVint(buf, cursor + idVint.length, true);
      if (!sizeVint) break;
      const start = cursor + idVint.length + sizeVint.length;
      if (start + sizeVint.value > buf.length) break;

      if (idVint.value === ID_TIMESCALE) {
        this.timestampScaleNs = readUintBE(buf, start, sizeVint.value) || 1_000_000;
      } else if (idVint.value === ID_DURATION) {
        rawDuration = readFloatBE(buf, start, sizeVint.value);
      }
      cursor = start + sizeVint.value;
    }
    if (rawDuration > 0) {
      this.durationSec = (rawDuration * this.timestampScaleNs) / 1_000_000_000;
    }
  }

  private parseTracks(buf: Uint8Array): void {
    let cursor = 0;
    while (cursor < buf.length) {
      const idVint = readEbmlVint(buf, cursor, false);
      if (!idVint) break;
      const sizeVint = readEbmlVint(buf, cursor + idVint.length, true);
      if (!sizeVint) break;
      const start = cursor + idVint.length + sizeVint.length;
      if (start + sizeVint.value > buf.length) break;

      if (idVint.value === ID_TRACK_ENTRY) {
        const track = this.parseTrackEntry(buf.subarray(start, start + sizeVint.value));
        if (track) this.tracks.push(track);
      }
      cursor = start + sizeVint.value;
    }
  }

  private parseTrackEntry(buf: Uint8Array): MkvTrack | null {
    const track: MkvTrack = {
      trackNumber: 0,
      trackType: 0,
      codecId: '',
      width: 1280,
      height: 720,
      sampleRate: 48000,
      channels: 2,
    };

    let cursor = 0;
    while (cursor < buf.length) {
      const idVint = readEbmlVint(buf, cursor, false);
      if (!idVint) break;
      const sizeVint = readEbmlVint(buf, cursor + idVint.length, true);
      if (!sizeVint) break;
      const start = cursor + idVint.length + sizeVint.length;
      if (start + sizeVint.value > buf.length) break;
      const payload = buf.subarray(start, start + sizeVint.value);

      if (idVint.value === ID_TRACK_NUMBER) {
        track.trackNumber = readUintBE(payload, 0, payload.length);
      } else if (idVint.value === ID_TRACK_TYPE) {
        track.trackType = readUintBE(payload, 0, payload.length);
      } else if (idVint.value === ID_CODEC_ID) {
        track.codecId = readAscii(payload, 0, payload.length);
      } else if (idVint.value === ID_CODEC_PRIVATE) {
        track.codecPrivate = new Uint8Array(payload);
      } else if (idVint.value === ID_VIDEO) {
        this.parseVideoSettings(payload, track);
      } else if (idVint.value === ID_AUDIO) {
        this.parseAudioSettings(payload, track);
      }
      cursor = start + sizeVint.value;
    }

    return track.trackNumber > 0 ? track : null;
  }

  private parseVideoSettings(buf: Uint8Array, track: MkvTrack): void {
    let cursor = 0;
    while (cursor < buf.length) {
      const idVint = readEbmlVint(buf, cursor, false);
      if (!idVint) break;
      const sizeVint = readEbmlVint(buf, cursor + idVint.length, true);
      if (!sizeVint) break;
      const start = cursor + idVint.length + sizeVint.length;
      if (start + sizeVint.value > buf.length) break;
      if (idVint.value === ID_PIXEL_WIDTH) {
        track.width = readUintBE(buf, start, sizeVint.value);
      } else if (idVint.value === ID_PIXEL_HEIGHT) {
        track.height = readUintBE(buf, start, sizeVint.value);
      }
      cursor = start + sizeVint.value;
    }
  }

  private parseAudioSettings(buf: Uint8Array, track: MkvTrack): void {
    let cursor = 0;
    while (cursor < buf.length) {
      const idVint = readEbmlVint(buf, cursor, false);
      if (!idVint) break;
      const sizeVint = readEbmlVint(buf, cursor + idVint.length, true);
      if (!sizeVint) break;
      const start = cursor + idVint.length + sizeVint.length;
      if (start + sizeVint.value > buf.length) break;
      if (idVint.value === ID_SAMPLING_FREQ) {
        track.sampleRate = Math.round(readFloatBE(buf, start, sizeVint.value)) || 48000;
      } else if (idVint.value === ID_CHANNELS) {
        track.channels = readUintBE(buf, start, sizeVint.value) || 2;
      }
      cursor = start + sizeVint.value;
    }
  }

  private emitReady(): void {
    this.readyEmitted = true;
    const videoTrack = this.tracks.find((t) => t.trackType === 1);
    if (!videoTrack) {
      if (this.callbacks.onError) {
        this.callbacks.onError(new Error('No video track found in the provided MKV/WebM file.'));
      }
      return;
    }

    this.selectedVideoTrack = videoTrack;
    const audioTracks = this.tracks.filter((t) => t.trackType === 2);

    // Pick best audio track (AAC/Opus first, stereo <= 2ch preferred)
    const sortedAudio = [...audioTracks].sort((a, b) => {
      const aSupp = mapMatroskaAudioCodec(a.codecId) !== null;
      const bSupp = mapMatroskaAudioCodec(b.codecId) !== null;
      if (aSupp !== bSupp) return aSupp ? -1 : 1;
      const aStereo = a.channels <= 2;
      const bStereo = b.channels <= 2;
      if (aStereo !== bStereo) return aStereo ? -1 : 1;
      return a.channels - b.channels;
    });

    const bestAudio = sortedAudio[0];
    let audioInfo: DemuxerAudioInfo | undefined;
    if (bestAudio) {
      const muxerCodec = mapMatroskaAudioCodec(bestAudio.codecId);
      const isMuxerSupported = muxerCodec !== null;
      this.selectedAudioTrack = bestAudio;
      audioInfo = {
        trackId: bestAudio.trackNumber,
        codec: bestAudio.codecId,
        muxerCodec,
        isMuxerSupported,
        numberOfChannels: bestAudio.channels,
        sampleRate: bestAudio.sampleRate,
        timescale: 1000,
        bitrate: 0,
        description: bestAudio.codecPrivate,
      };
    }

    const webCodec = mapMatroskaVideoCodec(videoTrack.codecId, videoTrack.codecPrivate);
    const useDescription =
      videoTrack.codecId === 'V_MPEG4/ISO/AVC' || videoTrack.codecId === 'V_MPEGH/ISO/HEVC'
        ? videoTrack.codecPrivate
        : undefined;

    const targetWidth = Math.floor(videoTrack.width / 2) * 2;
    const targetHeight = Math.floor(videoTrack.height / 2) * 2;

    const readyInfo: DemuxerReadyInfo = {
      trackId: videoTrack.trackNumber,
      codec: webCodec,
      width: videoTrack.width,
      height: videoTrack.height,
      targetWidth: Math.max(2, targetWidth),
      targetHeight: Math.max(2, targetHeight),
      isDownscaled: false,
      duration: Math.round(this.durationSec * 1000),
      timescale: 1000,
      nbSamples: Math.max(1, Math.round(this.durationSec * 30)),
      totalAudioTracks: audioTracks.length,
      description: useDescription,
      audioInfo,
    };

    this.callbacks.onReady(readyInfo);
  }

  private async parseBlockGroup(buf: Uint8Array): Promise<void> {
    let cursor = 0;
    let blockPayload: Uint8Array | null = null;
    let blockDuration = 0;

    while (cursor < buf.length) {
      const idVint = readEbmlVint(buf, cursor, false);
      if (!idVint) break;
      const sizeVint = readEbmlVint(buf, cursor + idVint.length, true);
      if (!sizeVint) break;
      const start = cursor + idVint.length + sizeVint.length;
      if (start + sizeVint.value > buf.length) break;

      if (idVint.value === ID_BLOCK) {
        blockPayload = buf.subarray(start, start + sizeVint.value);
      } else if (idVint.value === ID_BLOCK_DURATION) {
        blockDuration = readUintBE(buf, start, sizeVint.value);
      }
      cursor = start + sizeVint.value;
    }

    if (blockPayload) {
      await this.handleBlock(blockPayload, false, blockDuration);
    }
  }

  private async handleBlock(data: Uint8Array, isSimpleBlock: boolean, blockDurationUnits: number): Promise<void> {
    const header = parseBlockHeader(data, isSimpleBlock);
    if (!header) return;

    const absTimeNs = (this.currentClusterTs + header.relativeTimestamp) * this.timestampScaleNs;
    const timestampUs = Math.max(0, Math.round(absTimeNs / 1000));
    const durationUs =
      blockDurationUnits > 0 ? Math.round((blockDurationUnits * this.timestampScaleNs) / 1000) : 33_333;

    if (this.selectedVideoTrack && header.trackNumber === this.selectedVideoTrack.trackNumber) {
      const frames = splitLacedFrames(data, header.payloadOffset, header.lacing);
      for (const frameData of frames) {
        if (this.isCancelled) return;
        this.sampleCount++;
        this.lastVideoTimestampUs = Math.max(this.lastVideoTimestampUs, timestampUs + durationUs);

        const chunk = new EncodedVideoChunk({
          type: header.isKeyframe || this.sampleCount === 1 ? 'key' : 'delta',
          timestamp: timestampUs,
          duration: durationUs,
          data: frameData,
        });
        this.callbacks.onSample(chunk);

        if (this.sampleCount % 10 === 0 && this.callbacks.checkBackpressure) {
          await this.callbacks.checkBackpressure();
        }
      }
    } else if (this.selectedAudioTrack && header.trackNumber === this.selectedAudioTrack.trackNumber) {
      const frames = splitLacedFrames(data, header.payloadOffset, header.lacing);
      for (const frameData of frames) {
        if (this.isCancelled) return;
        this.audioTrackSize += frameData.byteLength;
        if (this.callbacks.onAudioSample) {
          const audioChunk = new EncodedAudioChunk({
            type: 'key',
            timestamp: timestampUs,
            duration: durationUs,
            data: frameData,
          });
          this.callbacks.onAudioSample(audioChunk);
        }
      }
    }
  }
}
