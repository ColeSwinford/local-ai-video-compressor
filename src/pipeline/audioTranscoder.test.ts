import { describe, expect, it } from 'vitest';
import { downmixChannelsToStereo, mapToWebCodecsAudioCodec } from './audioTranscoder';
import { buildAacAudioSpecificConfig } from './demuxer';

describe('mapToWebCodecsAudioCodec', () => {
  it('maps Matroska and MP4 audio codec IDs to WebCodecs strings', () => {
    expect(mapToWebCodecsAudioCodec('A_AAC/MPEG4/LC')).toBe('mp4a.40.2');
    expect(mapToWebCodecsAudioCodec('A_OPUS')).toBe('opus');
    expect(mapToWebCodecsAudioCodec('A_AC3')).toBe('ac-3');
    expect(mapToWebCodecsAudioCodec('A_EAC3')).toBe('ec-3');
    expect(mapToWebCodecsAudioCodec('mp4a.40.2')).toBe('mp4a.40.2');
  });
});

describe('downmixChannelsToStereo', () => {
  it('duplicates mono channel into L/R stereo', () => {
    const mono = new Float32Array([0.25, -0.5]);
    const out = downmixChannelsToStereo([mono], 2);
    expect(Array.from(out)).toEqual([0.25, -0.5, 0.25, -0.5]);
  });

  it('preserves stereo channels cleanly', () => {
    const l = new Float32Array([0.1, 0.2]);
    const r = new Float32Array([-0.1, -0.2]);
    const out = downmixChannelsToStereo([l, r], 2);
    expect(out[0]).toBeCloseTo(0.1, 5);
    expect(out[1]).toBeCloseTo(0.2, 5);
    expect(out[2]).toBeCloseTo(-0.1, 5);
    expect(out[3]).toBeCloseTo(-0.2, 5);
  });

  it('downmixes 5.1 surround to clipped stereo', () => {
    const chL = new Float32Array([0.5]);
    const chR = new Float32Array([0.2]);
    const chC = new Float32Array([0.4]);
    const chLfe = new Float32Array([0.9]);
    const chLs = new Float32Array([0.1]);
    const chRs = new Float32Array([0.1]);
    const out = downmixChannelsToStereo([chL, chR, chC, chLfe, chLs, chRs], 1);

    const invSqrt2 = 0.70710678;
    expect(out[0]).toBeCloseTo(0.5 + 0.4 * invSqrt2 + 0.1 * invSqrt2, 4);
    expect(out[1]).toBeCloseTo(0.2 + 0.4 * invSqrt2 + 0.1 * invSqrt2, 4);
  });
});

describe('buildAacAudioSpecificConfig', () => {
  it('builds 2-byte AudioSpecificConfig for 48kHz stereo and 44.1kHz mono AAC-LC', () => {
    // 48kHz (idx 3), 2ch, AAC-LC (2) -> 0x11, 0x90
    expect(Array.from(buildAacAudioSpecificConfig(48000, 2))).toEqual([0x11, 0x90]);
    // 44.1kHz (idx 4), 1ch, AAC-LC (2) -> 0x12, 0x08
    expect(Array.from(buildAacAudioSpecificConfig(44100, 1))).toEqual([0x12, 0x08]);
  });
});
