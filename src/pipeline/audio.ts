import type { MP4AudioTrack } from '../types/mp4box';

export type MuxerAudioCodec = 'aac' | 'opus';

export interface SelectedAudioTrack {
  track: MP4AudioTrack;
  muxerCodec: MuxerAudioCodec | null;
  isMuxerSupported: boolean;
  numberOfChannels: number;
  sampleRate: number;
  bitrate: number;
}

export interface PreflightWarning {
  level: 'warn' | 'info';
  message: string;
}

export interface PreflightParams {
  fileSizeBytes: number;
  targetMB: number;
  durationSec: number;
  totalAudioTracks: number;
  selectedAudio?: {
    codec: string;
    isMuxerSupported: boolean;
    numberOfChannels: number;
    estimatedAudioBytes: number;
  };
  targetVideoBitrate: number;
}

const SUPPORTED_MP4_EXTENSIONS = new Set(['mp4', 'mov', 'm4v']);

/**
 * Checks whether the input filename has an ISO Base Media container extension supported by MP4Box.
 */
export function isSupportedContainerFile(filename: string): { supported: boolean; extension: string } {
  const parts = filename.trim().toLowerCase().split('.');
  const extension = parts.length > 1 ? parts[parts.length - 1] : '';
  return {
    supported: SUPPORTED_MP4_EXTENSIONS.has(extension),
    extension,
  };
}

/**
 * Maps an MP4Box audio codec string to an mp4-muxer supported codec, or null if unsupported.
 * mp4-muxer only supports AAC (mp4a.*) and Opus (opus/Opus).
 */
export function getMuxerAudioCodec(codec: string): MuxerAudioCodec | null {
  const normalized = codec.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes('opus')) return 'opus';
  if (normalized.startsWith('mp4a') || normalized.includes('aac')) return 'aac';
  return null;
}

/**
 * Selects the best audio track from a multi-track container.
 * Prefers mp4-muxer compatible codecs (AAC/Opus) first, then stereo (<= 2ch) over surround
 * to preserve target-size budgets and iMessage/QuickTime compatibility.
 */
export function selectBestAudioTrack(audioTracks: MP4AudioTrack[]): SelectedAudioTrack | undefined {
  if (!audioTracks || audioTracks.length === 0) return undefined;

  const candidates: SelectedAudioTrack[] = audioTracks.map((track) => {
    const muxerCodec = getMuxerAudioCodec(track.codec || '');
    const numberOfChannels = track.audio?.channel_count || (track as unknown as { channel_count?: number }).channel_count || 2;
    const sampleRate = track.audio?.sample_rate || (track as unknown as { sample_rate?: number }).sample_rate || 44100;
    const bitrate = track.bitrate || 0;
    return {
      track,
      muxerCodec,
      isMuxerSupported: muxerCodec !== null,
      numberOfChannels,
      sampleRate,
      bitrate,
    };
  });

  candidates.sort((a, b) => {
    // 1. Supported by mp4-muxer before unsupported
    if (a.isMuxerSupported !== b.isMuxerSupported) {
      return a.isMuxerSupported ? -1 : 1;
    }
    // 2. Stereo/mono (<= 2 channels) before multi-channel surround
    const aStereo = a.numberOfChannels <= 2;
    const bStereo = b.numberOfChannels <= 2;
    if (aStereo !== bStereo) {
      return aStereo ? -1 : 1;
    }
    // 3. Lower channel count preferred to save bitrate budget
    if (a.numberOfChannels !== b.numberOfChannels) {
      return a.numberOfChannels - b.numberOfChannels;
    }
    return 0;
  });

  return candidates[0];
}

/**
 * Evaluates preflight warnings for large files, multi-track/unsupported audio, and tight bit budgets.
 */
export function evaluatePreflightWarnings(params: PreflightParams): PreflightWarning[] {
  const warnings: PreflightWarning[] = [];
  const targetBytes = params.targetMB * 1024 * 1024;

  if (params.fileSizeBytes > 2 * 1024 * 1024 * 1024) {
    const gb = (params.fileSizeBytes / (1024 * 1024 * 1024)).toFixed(2);
    warnings.push({
      level: 'info',
      message: `Large input detected (${gb} GB). Streaming in 4 MB chunks to keep browser memory bounded.`,
    });
  }

  if (params.totalAudioTracks > 1) {
    warnings.push({
      level: 'info',
      message: `Detected ${params.totalAudioTracks} audio tracks; automatically selecting the most compatible track.`,
    });
  }

  if (params.selectedAudio) {
    if (!params.selectedAudio.isMuxerSupported) {
      warnings.push({
        level: 'warn',
        message: `Audio codec "${params.selectedAudio.codec}" (${params.selectedAudio.numberOfChannels}ch) is not supported for MP4 passthrough. Exporting video-only to avoid muxing failure.`,
      });
    } else if (params.selectedAudio.estimatedAudioBytes >= targetBytes * 0.75) {
      const audioMB = (params.selectedAudio.estimatedAudioBytes / (1024 * 1024)).toFixed(1);
      warnings.push({
        level: 'warn',
        message: `Passthrough audio (${params.selectedAudio.numberOfChannels}ch, ~${audioMB} MB) consumes >=75% of your ${params.targetMB} MB target; final file may exceed target size.`,
      });
    }
  }

  if (params.targetVideoBitrate > 0 && params.targetVideoBitrate < 150_000 && params.durationSec > 0) {
    const kbps = Math.round(params.targetVideoBitrate / 1000);
    warnings.push({
      level: 'warn',
      message: `Very low video bitrate (${kbps} kbps for ${params.durationSec.toFixed(0)}s at ${params.targetMB} MB). Consider a larger target or lower resolution/FPS.`,
    });
  }

  return warnings;
}
