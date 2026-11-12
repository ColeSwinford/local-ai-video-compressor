import { describe, expect, it } from 'vitest';
import { selectH264CodecString } from './encoder';

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
