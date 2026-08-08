import * as ort from 'onnxruntime-web/webgpu';

export interface ComplexityDetectorOptions {
  modelUrl?: string;
  inputWidth?: number;
  inputHeight?: number;
  inferenceStride?: number;
}

export interface ComplexityProcessResult {
  score: number; // Unified complexity metric (spatialScore + motionScore * 1.5)
  inferenceTimeMs: number;
  isMock: boolean;
  isSkipped: boolean;
}

export class SceneComplexityDetector {
  private session: ort.InferenceSession | null = null;
  private inputWidth: number;
  private inputHeight: number;
  private inferenceStride: number;
  private frameCounter = 0;

  // 224x224 canvas for MobileNet / Classification tensor extraction
  private inputCanvas: OffscreenCanvas | HTMLCanvasElement;
  private inputCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

  private isFallbackMode = false;
  private modelUrl: string;
  private lastInferenceTimeMs = 0;
  private lastScore = 0.5;
  private previousRgba: Uint8ClampedArray | null = null;

  constructor(options: ComplexityDetectorOptions = {}) {
    this.modelUrl = options.modelUrl || '/model.onnx';
    this.inputWidth = options.inputWidth || 224;
    this.inputHeight = options.inputHeight || 224;
    this.inferenceStride = options.inferenceStride || 15;

    if (typeof OffscreenCanvas !== 'undefined') {
      this.inputCanvas = new OffscreenCanvas(this.inputWidth, this.inputHeight);
      this.inputCtx = this.inputCanvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    } else {
      this.inputCanvas = document.createElement('canvas');
      this.inputCanvas.width = this.inputWidth;
      this.inputCanvas.height = this.inputHeight;
      this.inputCtx = this.inputCanvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    }
  }

  /**
   * Initializes the ONNX InferenceSession using WebGPU execution provider.
   */
  public async init(): Promise<boolean> {
    try {
      console.log(`[Complexity] Attempting to load ONNX classification model from ${this.modelUrl} with WebGPU...`);
      this.session = await ort.InferenceSession.create(this.modelUrl, {
        executionProviders: ['webgpu'],
      });
      console.log('[Complexity] ONNX WebGPU classification session created successfully.');
      this.isFallbackMode = false;
      return true;
    } catch (err: any) {
      console.warn(
        `[Complexity] WebGPU session creation for ${this.modelUrl} unfulfilled (${err?.message || err}). Activating scaffold/fallback mode.`,
      );
      this.isFallbackMode = true;
      return false;
    }
  }

  /**
   * Preprocessing: Uses createImageBitmap for zero-copy GPU downscaling to 224x224,
   * draws 224x224 ImageBitmap onto OffscreenCanvas, extracts ImageData, and converts RGB into ort.Tensor [1, 3, 224, 224].
   */
  public async preprocess224(frame: VideoFrame): Promise<{ tensor: ort.Tensor; rgba: Uint8ClampedArray }> {
    const bitmap = await createImageBitmap(frame, {
      resizeWidth: this.inputWidth,
      resizeHeight: this.inputHeight,
      resizeQuality: 'low',
    });

    try {
      this.inputCtx.drawImage(bitmap, 0, 0);
    } finally {
      bitmap.close();
    }

    const imageData = this.inputCtx.getImageData(0, 0, this.inputWidth, this.inputHeight);
    const rgba = imageData.data;

    const numPixels = this.inputWidth * this.inputHeight; // 224 * 224 = 50,176
    const tensorData = new Float32Array(3 * numPixels); // 150,528 floats

    const rOffset = 0;
    const gOffset = numPixels;
    const bOffset = 2 * numPixels;

    for (let i = 0; i < numPixels; i++) {
      tensorData[rOffset + i] = rgba[i * 4] / 255.0;
      tensorData[gOffset + i] = rgba[i * 4 + 1] / 255.0;
      tensorData[bOffset + i] = rgba[i * 4 + 2] / 255.0;
    }

    return {
      tensor: new ort.Tensor('float32', tensorData, [1, 3, this.inputHeight, this.inputWidth]),
      rgba,
    };
  }

  /**
   * Calculates Mean Absolute Difference (MAD) pixel delta in range [0.0, 1.0] between adjacent sample frames.
   */
  private calculatePixelDeltaMAD(currentRgba: Uint8ClampedArray, previousRgba: Uint8ClampedArray | null): number {
    if (!previousRgba || previousRgba.length !== currentRgba.length) {
      return 0;
    }
    let totalDiff = 0;
    const len = currentRgba.length;
    for (let i = 0; i < len; i += 4) {
      totalDiff += Math.abs(currentRgba[i] - previousRgba[i]) +
                   Math.abs(currentRgba[i + 1] - previousRgba[i + 1]) +
                   Math.abs(currentRgba[i + 2] - previousRgba[i + 2]);
    }
    const numPixels = len / 4;
    return Math.min(1.0, totalDiff / (numPixels * 3 * 255));
  }

  /**
   * Parses 1D logit array from ONNX output tensor and computes spatial complexity score in [0.0, 1.0].
   */
  private extractScoreFromTensor(outputTensor: ort.Tensor): number {
    const logits = outputTensor.data as Float32Array;
    if (!logits || logits.length === 0) return 0.5;

    let sum = 0;
    for (let i = 0; i < logits.length; i++) {
      sum += Math.abs(logits[i] || 0);
    }
    const avg = sum / logits.length;
    return 1.0 / (1.0 + Math.exp(-avg));
  }

  /**
   * Evaluates frame complexity combining spatial score and temporal motion score:
   * unifiedScore = spatialScore + (motionScore * 1.5)
   */
  public async processFrame(frame: VideoFrame): Promise<ComplexityProcessResult> {
    let inputTensor: ort.Tensor | null = null;
    let outputTensor: ort.Tensor | null = null;

    const shouldRunInference = this.frameCounter % this.inferenceStride === 0 || this.frameCounter === 0;
    this.frameCounter++;

    try {
      if (shouldRunInference) {
        const startMs = performance.now();

        // 1. Preprocess 224x224 input tensor and extract RGBA pixel buffer
        const { tensor, rgba } = await this.preprocess224(frame);
        inputTensor = tensor;

        // 2. Compute Temporal Motion Score via MAD pixel delta
        const motionScore = this.calculatePixelDeltaMAD(rgba, this.previousRgba);
        this.previousRgba = new Uint8ClampedArray(rgba);

        // 3. ONNX WebGPU Inference for Spatial Score
        let spatialScore = 0.5;
        if (this.session && !this.isFallbackMode) {
          const inputName = this.session.inputNames[0] || 'input';
          const feeds: Record<string, ort.Tensor> = { [inputName]: inputTensor };
          const results = await this.session.run(feeds);
          const outputName = this.session.outputNames[0] || Object.keys(results)[0];
          outputTensor = results[outputName];
          spatialScore = this.extractScoreFromTensor(outputTensor);
        } else {
          // Fallback mock spatial complexity score
          spatialScore = Math.min(0.95, Math.max(0.05, 0.3 + Math.random() * 0.5));
        }

        // 4. Combine spatial and temporal motion scores into unified complexity metric
        this.lastScore = spatialScore + (motionScore * 1.5);
        this.lastInferenceTimeMs = performance.now() - startMs;
      }

      return {
        score: this.lastScore,
        inferenceTimeMs: this.lastInferenceTimeMs,
        isMock: this.isFallbackMode,
        isSkipped: !shouldRunInference,
      };
    } finally {
      if (inputTensor) {
        try {
          inputTensor.dispose();
        } catch {}
      }
      if (outputTensor) {
        try {
          outputTensor.dispose();
        } catch {}
      }
    }
  }

  public setInferenceStride(stride: number): void {
    if (stride >= 1) {
      this.inferenceStride = stride;
    }
  }

  public resetFrameCounter(): void {
    this.frameCounter = 0;
    this.lastScore = 0.5;
    this.previousRgba = null;
  }
}
