import { describe, expect, it } from 'vitest';
import type { ComplexityEntry } from '../types';
import { allocateBitrates, findClosestComplexityEntry } from './allocator';

describe('findClosestComplexityEntry', () => {
  it('returns undefined for empty map', () => {
    expect(findClosestComplexityEntry([], 500_000)).toBeUndefined();
  });

  it('finds the closest timestamp entry', () => {
    const map: ComplexityEntry[] = [
      { timestamp: 0, score: 0.2 },
      { timestamp: 1_000_000, score: 0.5 },
      { timestamp: 2_000_000, score: 0.9 },
    ];
    expect(findClosestComplexityEntry(map, 1_100_000)?.score).toBe(0.5);
    expect(findClosestComplexityEntry(map, 1_800_000)?.score).toBe(0.9);
  });
});

describe('allocateBitrates', () => {
  it('allocates bitrates and keyframes across uniform frames', () => {
    const map: ComplexityEntry[] = Array.from({ length: 60 }, (_, i) => ({
      timestamp: i * 33_333,
      score: 0.5,
    }));

    const result = allocateBitrates({
      complexityMap: map,
      targetMB: 10,
      audioBytes: 500_000,
      trueDuration: 2,
      targetIntervalUs: 0,
      maxKeyframeDistance: 60,
    });

    expect(result.complexityMap).toHaveLength(60);
    expect(result.targetVideoBitrate).toBeGreaterThan(0);
    expect(result.segmentCount).toBeGreaterThanOrEqual(2);
    expect(result.keyframeCount).toBeGreaterThanOrEqual(1);
    expect(result.complexityMap[0].isKeyframe).toBe(true);
    expect(result.complexityMap.every((e) => (e.targetBitrate ?? 0) >= 100_000)).toBe(true);
  });

  it('applies FPS decimation when targetIntervalUs is set', () => {
    const map: ComplexityEntry[] = Array.from({ length: 30 }, (_, i) => ({
      timestamp: i * 33_333,
      score: 0.5,
    }));

    const result = allocateBitrates({
      complexityMap: map,
      targetMB: 5,
      audioBytes: 0,
      trueDuration: 1,
      targetIntervalUs: 100_000, // ~10 FPS
      maxKeyframeDistance: 20,
    });

    expect(result.complexityMap.length).toBeLessThan(30);
    expect(result.complexityMap.length).toBeGreaterThanOrEqual(9);
  });

  it('places a keyframe and starts a new segment on a >40% complexity jump', () => {
    const map: ComplexityEntry[] = [
      { timestamp: 0, score: 0.2 },
      { timestamp: 33_333, score: 0.2 },
      { timestamp: 66_666, score: 0.8 }, // 4x jump -> new segment + keyframe
      { timestamp: 100_000, score: 0.8 },
    ];

    const result = allocateBitrates({
      complexityMap: map,
      targetMB: 5,
      audioBytes: 0,
      trueDuration: 1,
      targetIntervalUs: 0,
      maxKeyframeDistance: 60,
    });

    expect(result.segmentCount).toBe(2);
    expect(result.complexityMap[0].isKeyframe).toBe(true);
    expect(result.complexityMap[2].isKeyframe).toBe(true);
    expect(result.complexityMap[2].targetBitrate!).toBeGreaterThan(result.complexityMap[0].targetBitrate!);
  });

  it('enforces the 25% minimum video byte floor when audioBytes exceeds targetBytes', () => {
    const map: ComplexityEntry[] = [
      { timestamp: 0, score: 0.5 },
      { timestamp: 500_000, score: 0.5 },
    ];

    const targetMB = 10;
    const result = allocateBitrates({
      complexityMap: map,
      targetMB,
      audioBytes: 50 * 1024 * 1024, // 50 MB audio > 10 MB target
      trueDuration: 10,
      targetIntervalUs: 0,
      maxKeyframeDistance: 60,
    });

    const expectedFloorBps = Math.floor((targetMB * 1024 * 1024 * 0.25 * 8) / 10);
    expect(result.targetVideoBitrate).toBe(expectedFloorBps);
  });
});
