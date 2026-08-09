export interface ComplexityEntry {
  timestamp: number;
  score: number;
  targetBitrate?: number;
  isKeyframe?: boolean;
}

export type StatusState = 'ready' | 'working' | 'complete' | 'error';
export type LogType = 'info' | 'success' | 'warn' | 'error';

export interface CompressionOptions {
  file: File;
  targetMB: number;
  resMode: string;
  selectedFps: string;
  canvas: HTMLCanvasElement;
  canvasCtx: CanvasRenderingContext2D;
  canvasPlaceholder?: HTMLDivElement | null;
  outputVideoPlayer?: HTMLVideoElement | null;
  onProgress?: (percent: number, passText: string) => void;
  onStatusChange?: (state: StatusState, text: string) => void;
  onLog?: (text: string, type?: LogType) => void;
  onFrameDecoded?: (frameCount: number, pass: 1 | 2, fpsText: string) => void;
  onReadyInfo?: (info: {
    codec: string;
    width: number;
    height: number;
    targetWidth: number;
    targetHeight: number;
    nbSamples: number;
    description?: Uint8Array;
  }) => void;
}

export interface CompressionResult {
  url: string;
  filename: string;
  byteSize: number;
  sizeMb: string;
  savingsPct: number;
  durationSec: string;
  decodedFrameCount: number;
  avgKbps: number;
}

export type { DemuxerReadyInfo } from '../pipeline/demuxer';
export type { EncoderMuxerAudioConfig, EncoderMuxerConfig } from '../pipeline/encoder';
export type { ComplexityDetectorOptions, ComplexityProcessResult } from '../pipeline/complexity';
export type { VideoDecoderCallbacks } from '../pipeline/decoder';
