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

declare module 'mp4box' {
  export class DataStream {
    static BIG_ENDIAN: boolean;
    static LITTLE_ENDIAN: boolean;
    buffer: ArrayBuffer;
    position: number;
    constructor(buffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean);
    writeUint32(value: number): void;
    writeString(value: string): void;
    writeUint8Array(value: Uint8Array): void;
  }

  export interface MP4BoxFile {
    onReady?: (info: MP4ArrayBufferInfo) => void;
    onSamples?: (id: number, user: any, samples: MP4Sample[]) => void;
    onError?: (e: string | Error) => void;
    appendBuffer(data: ArrayBuffer & { fileStart?: number }): number;
    start(): void;
    stop(): void;
    flush(): void;
    getTrackById(id: number): any;
    setExtractionOptions(id: number, user?: any, options?: { nbSamples?: number; [key: string]: any }): void;
  }

  export function createFile(): MP4BoxFile;
}
