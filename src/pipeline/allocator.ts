import type { ComplexityEntry } from '../types';

export interface SegmentInfo {
  startIndex: number;
  endIndex: number;
  avgScore: number;
  targetBitrate: number;
}

export interface BitAllocationInput {
  complexityMap: ComplexityEntry[];
  targetMB: number;
  audioBytes: number;
  trueDuration: number;
  targetIntervalUs: number;
  maxKeyframeDistance: number;
}

export interface BitAllocationResult {
  complexityMap: ComplexityEntry[];
  targetVideoBitrate: number;
  avgBitrateBps: number;
  segmentCount: number;
  keyframeCount: number;
}

/**
 * Query pre-calculated targetBitrate from complexityMap matching the frame timestamp.
 */
export function findClosestComplexityEntry(
  complexityMap: ComplexityEntry[],
  timestamp: number,
): ComplexityEntry | undefined {
  if (complexityMap.length === 0) return undefined;
  let closest = complexityMap[0];
  let minDiff = Math.abs(timestamp - closest.timestamp);
  for (let i = 1; i < complexityMap.length; i++) {
    const diff = Math.abs(timestamp - complexityMap[i].timestamp);
    if (diff < minDiff) {
      minDiff = diff;
      closest = complexityMap[i];
    }
  }
  return closest;
}

/**
 * Computes two-pass VBR bit allocation, GOP segmentation, asymmetric EMA smoothing,
 * and scene-cut/interval keyframe placement from a Pass 1 complexity map.
 */
export function allocateBitrates(input: BitAllocationInput): BitAllocationResult {
  const { targetMB, audioBytes, trueDuration, targetIntervalUs, maxKeyframeDistance } = input;
  const safeDuration = trueDuration > 0 ? trueDuration : 1;

  const targetBytes = targetMB * 1024 * 1024;
  const containerOverhead = targetBytes * 0.015;

  const netVideoBytes = Math.max(targetBytes * 0.25, (targetBytes - audioBytes - containerOverhead) * 0.92);
  const targetVideoBitrate = Math.floor((netVideoBytes * 8) / safeDuration);
  const avgBitrateBps = targetVideoBitrate;
  const targetVideoBits = targetVideoBitrate * safeDuration;

  // Filter complexityMap to include ONLY frames that survive FPS decimation in Pass 2
  const survivingMap: ComplexityEntry[] = [];
  if (targetIntervalUs > 0) {
    let lastSurvivingUs = -1;
    for (const entry of input.complexityMap) {
      if (lastSurvivingUs < 0 || entry.timestamp - lastSurvivingUs >= targetIntervalUs - 2000) {
        survivingMap.push({ ...entry });
        lastSurvivingUs = entry.timestamp;
      }
    }
  } else {
    for (const entry of input.complexityMap) {
      survivingMap.push({ ...entry });
    }
  }

  // Group surviving complexityMap entries into 30-frame / 1-second / scene-cut bounded GOP segments
  const segments: SegmentInfo[] = [];
  let currentSegmentStart = 0;
  let currentSegmentSum = 0;
  let currentSegmentCount = 0;

  for (let i = 0; i < survivingMap.length; i++) {
    const entry = survivingMap[i];
    const prevEntry = i > 0 ? survivingMap[i - 1] : null;

    const isComplexityJump = prevEntry !== null && prevEntry.score > 0 && entry.score > prevEntry.score * 1.4;
    const framesInCurrentSegment = i - currentSegmentStart;
    const timeInCurrentSegmentSec = (entry.timestamp - survivingMap[currentSegmentStart].timestamp) / 1_000_000;

    const shouldCutSegment =
      i > 0 && (isComplexityJump || framesInCurrentSegment >= 30 || timeInCurrentSegmentSec >= 1.0);

    if (shouldCutSegment) {
      const segmentAvgScore = currentSegmentCount > 0 ? currentSegmentSum / currentSegmentCount : 0.5;
      segments.push({
        startIndex: currentSegmentStart,
        endIndex: i - 1,
        avgScore: segmentAvgScore,
        targetBitrate: 0,
      });

      currentSegmentStart = i;
      currentSegmentSum = 0;
      currentSegmentCount = 0;
    }

    currentSegmentSum += entry.score;
    currentSegmentCount++;
  }

  if (currentSegmentCount > 0) {
    const segmentAvgScore = currentSegmentSum / currentSegmentCount;
    segments.push({
      startIndex: currentSegmentStart,
      endIndex: survivingMap.length - 1,
      avgScore: segmentAvgScore,
      targetBitrate: 0,
    });
  }

  // Gentle Power-Curve Bit Allocator (exponent 1.2) across segments
  let minSegmentScore = Infinity;
  let maxSegmentScore = -Infinity;
  for (const seg of segments) {
    if (seg.avgScore < minSegmentScore) minSegmentScore = seg.avgScore;
    if (seg.avgScore > maxSegmentScore) maxSegmentScore = seg.avgScore;
  }

  const scoreRange = maxSegmentScore > minSegmentScore ? maxSegmentScore - minSegmentScore : 1.0;
  const powerWeights = new Float64Array(segments.length);
  let totalPowerWeightSum = 0;

  for (let i = 0; i < segments.length; i++) {
    const normalizedScore = Math.max(0.01, Math.min(1.0, (segments[i].avgScore - minSegmentScore) / scoreRange));
    const weightedWeight = Math.pow(normalizedScore, 1.2);
    powerWeights[i] = weightedWeight;
    totalPowerWeightSum += weightedWeight;
  }

  // Bitrate floor = 55% of avg bitrate, Bitrate cap = 2.2x avg bitrate
  const bitrateFloor = Math.max(100_000, Math.floor(avgBitrateBps * 0.55));
  const bitrateCap = Math.floor(avgBitrateBps * 2.2);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const weight = totalPowerWeightSum > 0 ? powerWeights[i] / totalPowerWeightSum : 1 / segments.length;
    const segmentBudgetBits = targetVideoBits * weight;

    const segStartUs = survivingMap[seg.startIndex].timestamp;
    const nextSegStartUs =
      i < segments.length - 1 ? survivingMap[segments[i + 1].startIndex].timestamp : segStartUs + 1_000_000;
    let segmentDurationSec = (nextSegStartUs - segStartUs) / 1_000_000;
    if (segmentDurationSec <= 0) segmentDurationSec = 1.0;

    let calculatedBitrate = Math.floor(segmentBudgetBits / segmentDurationSec);
    calculatedBitrate = Math.min(bitrateCap, Math.max(bitrateFloor, calculatedBitrate));
    seg.targetBitrate = calculatedBitrate;
  }

  // Asymmetric EMA Bitrate Smoothing across segments (Fast Attack alpha=0.85, Slow Decay alpha=0.15)
  let smoothedBitrate = segments[0]?.targetBitrate || Math.round(avgBitrateBps);
  for (let i = 0; i < segments.length; i++) {
    const rawBitrate = segments[i].targetBitrate || smoothedBitrate;
    const alpha = rawBitrate > smoothedBitrate ? 0.85 : 0.15;
    smoothedBitrate = alpha * rawBitrate + (1 - alpha) * smoothedBitrate;
    segments[i].targetBitrate = Math.round(smoothedBitrate);
  }

  // Map Segment Bitrates and Dynamic Keyframe Boundaries into surviving complexityMap
  let lastKeyframeTimestamp = survivingMap[0]?.timestamp || 0;
  let lastKeyframeIndex = 0;
  let keyframeCount = 0;

  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx];
    for (let idx = seg.startIndex; idx <= seg.endIndex; idx++) {
      survivingMap[idx].targetBitrate = seg.targetBitrate;

      const isComplexityJump =
        sIdx > 0 && idx === seg.startIndex && segments[sIdx].avgScore > segments[sIdx - 1].avgScore * 1.4;
      const timeDiffSec = (survivingMap[idx].timestamp - lastKeyframeTimestamp) / 1_000_000;
      const frameDiff = idx - lastKeyframeIndex;
      const isIntervalExceeded = timeDiffSec >= 2.0 || frameDiff >= maxKeyframeDistance;

      if (idx === 0 || isComplexityJump || isIntervalExceeded) {
        survivingMap[idx].isKeyframe = true;
        lastKeyframeTimestamp = survivingMap[idx].timestamp;
        lastKeyframeIndex = idx;
        keyframeCount++;
      } else {
        survivingMap[idx].isKeyframe = false;
      }
    }
  }

  return {
    complexityMap: survivingMap,
    targetVideoBitrate,
    avgBitrateBps,
    segmentCount: segments.length,
    keyframeCount,
  };
}
