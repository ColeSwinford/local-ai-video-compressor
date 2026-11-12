import { describe, expect, it } from 'vitest';
import { selectH264CodecString, shouldReconfigureBitrate } from './encoder';

describe('selectH264CodecString', () => {
  it('selects Level 4.2 for 1080p and below', () => {
    expect(selectH264CodecString(1920, 1080, 30)).toBe('avc1.64002a');
    expect(selectH264CodecString(1920, 1080, 60)).toBe('avc1.64002a');
    expect(selectH264CodecString(1280, 720, 30)).toBe('avc1.64002a');
  });

  it('selects Level 5.1 for 4K at 30fps', () => {
    expect(selectH264CodecString(3840, 2160, 30)).toBe('avc1.640033');
    expect(selectH264CodecString(2160, 3840, 30)).toBe('avc1.640033');
  });

  it('selects Level 5.2 for 4K at 60fps', () => {
    expect(selectH264CodecString(3840, 2160, 60)).toBe('avc1.640034');
  });
});

describe('shouldReconfigureBitrate', () => {
  it('allows reconfiguration at keyframe boundaries when delta >= 8% and cooldown >= 15 frames', () => {
    expect(shouldReconfigureBitrate(1_000_000, 1_200_000, true, 30)).toBe(true);
    expect(shouldReconfigureBitrate(1_000_000, 800_000, true, 15)).toBe(true);
  });

  it('skips reconfiguration on non-keyframes, small deltas, or within cooldown', () => {
    expect(shouldReconfigureBitrate(1_000_000, 1_500_000, false, 30)).toBe(false);
    expect(shouldReconfigureBitrate(1_000_000, 1_050_000, true, 30)).toBe(false);
    expect(shouldReconfigureBitrate(1_000_000, 1_500_000, true, 10)).toBe(false);
    expect(shouldReconfigureBitrate(1_000_000, 0, true, 30)).toBe(false);
  });
});
