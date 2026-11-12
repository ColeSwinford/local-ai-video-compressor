import { describe, expect, it, vi } from 'vitest';
import { rgbaToImageNetTensorData, SceneComplexityDetector } from './complexity';

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

describe('SceneComplexityDetector concurrency guard', () => {
  it('skips overlapping inference while an ONNX session.run() call is in flight', async () => {
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return {};
        }
      },
    );

    const detector = new SceneComplexityDetector({ inferenceStride: 1 });
    let resolveRun!: (value: Record<string, unknown>) => void;
    const runMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );

    (detector as any).session = {
      inputNames: ['input'],
      outputNames: ['output'],
      run: runMock,
    };
    (detector as any).isFallbackMode = false;
    (detector as any).preprocess224 = vi.fn().mockResolvedValue({
      tensor: { dispose: vi.fn() },
      rgba: new Uint8ClampedArray(4),
    });

    const fakeFrame = {} as VideoFrame;
    const p1 = detector.processFrame(fakeFrame);
    const p2 = detector.processFrame(fakeFrame);

    // Wait a microtask so p1 reaches session.run()
    await Promise.resolve();
    const res2 = await p2;
    expect(res2.isSkipped).toBe(true);
    expect(runMock).toHaveBeenCalledTimes(1);

    resolveRun({
      output: { data: new Float32Array([0.5, 1.5]), dispose: vi.fn() },
    });
    const res1 = await p1;
    expect(res1.isSkipped).toBe(false);

    // Once released, a subsequent frame runs inference again
    const p3 = detector.processFrame(fakeFrame);
    await Promise.resolve();
    expect(runMock).toHaveBeenCalledTimes(2);
    resolveRun({
      output: { data: new Float32Array([0.5, 1.5]), dispose: vi.fn() },
    });
    const res3 = await p3;
    expect(res3.isSkipped).toBe(false);

    vi.unstubAllGlobals();
  });
});
