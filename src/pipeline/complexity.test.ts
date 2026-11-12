import { describe, expect, it } from 'vitest';
import { rgbaToImageNetTensorData } from './complexity';

describe('rgbaToImageNetTensorData', () => {
  it('normalizes black and white pixels into NCHW ImageNet range', () => {
    // 2 pixels: [black (0,0,0,255), white (255,255,255,255)]
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    const out = rgbaToImageNetTensorData(rgba, 2);

    expect(out.length).toBe(6);
    // Pixel 0 (black): -mean / std
    expect(out[0]).toBeCloseTo(-0.485 / 0.229, 4);
    expect(out[2]).toBeCloseTo(-0.456 / 0.224, 4);
    expect(out[4]).toBeCloseTo(-0.406 / 0.225, 4);

    // Pixel 1 (white): (1 - mean) / std
    expect(out[1]).toBeCloseTo((1 - 0.485) / 0.229, 4);
    expect(out[3]).toBeCloseTo((1 - 0.456) / 0.224, 4);
    expect(out[5]).toBeCloseTo((1 - 0.406) / 0.225, 4);
  });
});
