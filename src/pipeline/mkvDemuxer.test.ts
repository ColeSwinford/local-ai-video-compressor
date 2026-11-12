import { describe, expect, it } from 'vitest';
import {
  mapMatroskaAudioCodec,
  mapMatroskaVideoCodec,
  parseBlockHeader,
  readEbmlVint,
} from './mkvDemuxer';

describe('readEbmlVint', () => {
  it('reads 1-byte and 2-byte masked VINT sizes', () => {
    // 0x85 -> 1-byte VINT with value 5
    expect(readEbmlVint(new Uint8Array([0x85]), 0, true)).toEqual({
      value: 5,
      length: 1,
      isUnknown: false,
    });

    // 0x41 0x00 -> 2-byte VINT with value 256
    expect(readEbmlVint(new Uint8Array([0x41, 0x00]), 0, true)).toEqual({
      value: 256,
      length: 2,
      isUnknown: false,
    });
  });

  it('preserves marker bit when reading Element IDs', () => {
    // 0x1A 0x45 0xDF 0xA3 -> EBML header ID
    expect(readEbmlVint(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 0, false)).toEqual({
      value: 0x1a45dfa3,
      length: 4,
      isUnknown: false,
    });
  });

  it('detects unknown-size VINT (all data bits 1)', () => {
    expect(readEbmlVint(new Uint8Array([0xff]), 0, true)?.isUnknown).toBe(true);
  });
});

describe('mapMatroskaVideoCodec', () => {
  it('maps H.264 CodecID using avcC CodecPrivate profile/level bytes', () => {
    const avcC = new Uint8Array([1, 0x64, 0x00, 0x2a]);
    expect(mapMatroskaVideoCodec('V_MPEG4/ISO/AVC', avcC)).toBe('avc1.64002a');
  });

  it('maps HEVC, VP9, and AV1 CodecIDs', () => {
    expect(mapMatroskaVideoCodec('V_MPEGH/ISO/HEVC')).toBe('hvc1.1.6.L150.B0');
    expect(mapMatroskaVideoCodec('V_VP9')).toBe('vp09.00.41.08');
    expect(mapMatroskaVideoCodec('V_AV1')).toBe('av01.0.08M.08');
  });
});

describe('mapMatroskaAudioCodec', () => {
  it('maps AAC and Opus and rejects DTS/AC-3', () => {
    expect(mapMatroskaAudioCodec('A_AAC')).toBe('aac');
    expect(mapMatroskaAudioCodec('A_AAC/MPEG4/LC')).toBe('aac');
    expect(mapMatroskaAudioCodec('A_OPUS')).toBe('opus');
    expect(mapMatroskaAudioCodec('A_DTS')).toBeNull();
    expect(mapMatroskaAudioCodec('A_AC3')).toBeNull();
  });
});

describe('parseBlockHeader', () => {
  it('parses track number, signed relative timestamp, keyframe flag, and lacing', () => {
    // track=1 (0x81), relTs=-10 (0xFF 0xF6), flags=0x80 (keyframe, no lacing)
    const block = new Uint8Array([0x81, 0xff, 0xf6, 0x80, 0xaa, 0xbb]);
    expect(parseBlockHeader(block, true)).toEqual({
      trackNumber: 1,
      relativeTimestamp: -10,
      isKeyframe: true,
      lacing: 0,
      payloadOffset: 4,
    });
  });
});
