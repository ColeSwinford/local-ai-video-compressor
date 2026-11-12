import { describe, expect, it } from 'vitest';
import type { MP4AudioTrack } from '../types/mp4box';
import { evaluatePreflightWarnings, getMuxerAudioCodec, isSupportedContainerFile, selectBestAudioTrack } from './audio';

function makeAudioTrack(id: number, codec: string, channelCount: number, sampleRate = 48000): MP4AudioTrack {
  return {
    id,
    created: new Date(),
    modified: new Date(),
    movie_duration: 0,
    layer: 0,
    alternate_group: 0,
    volume: 1,
    track_width: 0,
    track_height: 0,
    timescale: sampleRate,
    duration: sampleRate * 60,
    bitrate: 128_000,
    codec,
    language: 'eng',
    nb_samples: 1000,
    audio: {
      sample_rate: sampleRate,
      channel_count: channelCount,
    },
  };
}

describe('isSupportedContainerFile', () => {
  it('accepts mp4, mov, and m4v case-insensitively', () => {
    expect(isSupportedContainerFile('clip.mp4')).toEqual({ supported: true, extension: 'mp4', kind: 'mp4' });
    expect(isSupportedContainerFile('movie.MOV')).toEqual({ supported: true, extension: 'mov', kind: 'mp4' });
    expect(isSupportedContainerFile('show.m4v')).toEqual({ supported: true, extension: 'm4v', kind: 'mp4' });
  });

  it('accepts mkv and webm containers', () => {
    expect(isSupportedContainerFile('Succession.S04E10.mkv')).toEqual({
      supported: true,
      extension: 'mkv',
      kind: 'mkv',
    });
    expect(isSupportedContainerFile('video.webm')).toEqual({ supported: true, extension: 'webm', kind: 'mkv' });
  });

  it('rejects unsupported containers', () => {
    expect(isSupportedContainerFile('legacy.avi')).toEqual({ supported: false, extension: 'avi', kind: null });
    expect(isSupportedContainerFile('noext')).toEqual({ supported: false, extension: '', kind: null });
  });
});

describe('getMuxerAudioCodec', () => {
  it('recognizes AAC and Opus variants', () => {
    expect(getMuxerAudioCodec('mp4a.40.2')).toBe('aac');
    expect(getMuxerAudioCodec('Opus')).toBe('opus');
    expect(getMuxerAudioCodec('opus')).toBe('opus');
  });

  it('returns null for unsupported surround/lossless codecs', () => {
    expect(getMuxerAudioCodec('ac-3')).toBeNull();
    expect(getMuxerAudioCodec('ec-3')).toBeNull();
    expect(getMuxerAudioCodec('dtsc')).toBeNull();
    expect(getMuxerAudioCodec('')).toBeNull();
  });
});

describe('selectBestAudioTrack', () => {
  it('returns undefined when no audio tracks exist', () => {
    expect(selectBestAudioTrack([])).toBeUndefined();
  });

  it('prefers muxer-supported AAC stereo over unsupported AC-3 track 0', () => {
    const ac3Track = makeAudioTrack(1, 'ac-3', 6);
    const aacStereo = makeAudioTrack(2, 'mp4a.40.2', 2);
    const selected = selectBestAudioTrack([ac3Track, aacStereo]);

    expect(selected?.track.id).toBe(2);
    expect(selected?.isMuxerSupported).toBe(true);
    expect(selected?.muxerCodec).toBe('aac');
    expect(selected?.numberOfChannels).toBe(2);
  });

  it('prefers stereo over 5.1 when both are AAC', () => {
    const aacSurround = makeAudioTrack(1, 'mp4a.40.2', 6);
    const aacStereo = makeAudioTrack(2, 'mp4a.40.2', 2);
    const selected = selectBestAudioTrack([aacSurround, aacStereo]);

    expect(selected?.track.id).toBe(2);
    expect(selected?.numberOfChannels).toBe(2);
  });

  it('flags unsupported tracks when no supported track is available', () => {
    const dtsTrack = makeAudioTrack(1, 'dtsc', 6);
    const selected = selectBestAudioTrack([dtsTrack]);

    expect(selected?.track.id).toBe(1);
    expect(selected?.isMuxerSupported).toBe(false);
    expect(selected?.muxerCodec).toBeNull();
  });
});

describe('evaluatePreflightWarnings', () => {
  it('emits warnings for large files, multi-track, unsupported audio, oversized audio, and low bitrate', () => {
    const warnings = evaluatePreflightWarnings({
      fileSizeBytes: 10 * 1024 * 1024 * 1024, // 10 GB
      targetMB: 99,
      durationSec: 7200,
      totalAudioTracks: 3,
      selectedAudio: {
        codec: 'ac-3',
        isMuxerSupported: false,
        numberOfChannels: 6,
        estimatedAudioBytes: 200 * 1024 * 1024,
      },
      targetVideoBitrate: 100_000,
    });

    expect(warnings.some((w) => w.message.includes('10.00 GB'))).toBe(true);
    expect(warnings.some((w) => w.message.includes('3 audio tracks'))).toBe(true);
    expect(warnings.some((w) => w.message.includes('ac-3'))).toBe(true);
    expect(warnings.some((w) => w.message.includes('100 kbps'))).toBe(true);
  });

  it('warns when supported passthrough audio consumes >=75% of target size', () => {
    const warnings = evaluatePreflightWarnings({
      fileSizeBytes: 500 * 1024 * 1024,
      targetMB: 99,
      durationSec: 3600,
      totalAudioTracks: 1,
      selectedAudio: {
        codec: 'mp4a.40.2',
        isMuxerSupported: true,
        numberOfChannels: 6,
        estimatedAudioBytes: 85 * 1024 * 1024,
      },
      targetVideoBitrate: 500_000,
    });

    expect(warnings.some((w) => w.level === 'warn' && w.message.includes('>=75%'))).toBe(true);
  });
});
