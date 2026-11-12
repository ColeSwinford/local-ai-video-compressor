import { describe, expect, it } from 'vitest';
import { calculateTargetDimensions } from './dimensions';

describe('calculateTargetDimensions', () => {
  it('preserves even dimensions in auto mode', () => {
    expect(calculateTargetDimensions(1920, 1080, 'auto')).toEqual({ width: 1920, height: 1080 });
  });

  it('rounds odd dimensions down to even integers in auto mode', () => {
    expect(calculateTargetDimensions(1921, 1081, 'auto')).toEqual({ width: 1920, height: 1080 });
  });

  it('downscales 4K landscape to 1080p preserving aspect ratio', () => {
    expect(calculateTargetDimensions(3840, 2160, '1080')).toEqual({ width: 1920, height: 1080 });
  });

  it('downscales 4K portrait using the long edge', () => {
    expect(calculateTargetDimensions(2160, 3840, '1080')).toEqual({ width: 1080, height: 1920 });
  });

  it('downscales 1080p to 720p and 480p with even dimensions', () => {
    expect(calculateTargetDimensions(1920, 1080, '720')).toEqual({ width: 1280, height: 720 });
    expect(calculateTargetDimensions(1920, 1080, '480')).toEqual({ width: 854, height: 480 });
  });

  it('does not upscale smaller inputs when a larger cap is selected', () => {
    expect(calculateTargetDimensions(640, 360, '1080')).toEqual({ width: 640, height: 360 });
  });

  it('enforces a minimum dimension of 2px when scaled down', () => {
    expect(calculateTargetDimensions(4000, 3, '480')).toEqual({ width: 854, height: 2 });
  });
});
