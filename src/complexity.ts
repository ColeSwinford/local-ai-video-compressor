import * as ort from 'onnxruntime-web/webgpu';

export interface ComplexityDetectorOptions {
  modelUrl?: string;
  inputWidth?: number;
  inputHeight?: number;
  inferenceStride?: number;
}

export interface ComplexityProcessResult {
  score: number; // 0.0 (low complexity) to 1.0 (high complexity)
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
  public async preprocess224(frame: VideoFrame): Promise<ort.Tensor> {
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

    return new ort.Tensor('float32', tensorData, [1, 3, this.inputHeight, this.inputWidth]);
  }

  /**
   * Parses 1D logit array from ONNX output tensor and computes scene complexity score in [0.0, 1.0].
   */
  private extractScoreFromTensor(outputTensor: ort.Tensor): number {
    const logits = outputTensor.data as Float32Array;
    if (!logits || logits.length === 0) return 0.5;

    // Calculate variance or magnitude of logits as a proxy for scene motion/detail complexity
    let sum = 0;
    for (let i = 0; i < logits.length; i++) {
      sum += Math.abs(logits[i] || 0);
    }
    const avg = sum / logits.length;
    // Normalize to [0, 1] range using sigmoid-like curve
    return 1.0 / (1.0 + Math.exp(-avg));
  }

  /**
   * Evaluates frame complexity:
   * 1. Runs ONNX classification or mock scaffold every 15 frames (inferenceStride).
   * 2. Returns cached complexity score on non-inference frames.
   */
  public async processFrame(frame: VideoFrame): Promise<ComplexityProcessResult> {
    let inputTensor: ort.Tensor | null = null;
    let outputTensor: ort.Tensor | null = null;

    const shouldRunInference = this.frameCounter % this.inferenceStride === 0 || this.frameCounter === 0;
    this.frameCounter++;

    try {
      if (shouldRunInference) {
        const startMs = performance.now();

        // 1. Preprocess 224x224 MobileNet input tensor
        inputTensor = await this.preprocess224(frame);

        // 2. ONNX WebGPU Inference or Fallback Mock Scaffolding
        if (this.session && !this.isFallbackMode) {
          const inputName = this.session.inputNames[0] || 'input';
          const feeds: Record<string, ort.Tensor> = { [inputName]: inputTensor };
          const results = await this.session.run(feeds);
          const outputName = this.session.outputNames[0] || Object.keys(results)[0];
          outputTensor = results[outputName];
          this.lastScore = this.extractScoreFromTensor(outputTensor);
        } else {
          // Fallback mock complexity score between 0.1 and 0.9
          this.lastScore = Math.min(0.95, Math.max(0.05, 0.3 + Math.random() * 0.5));
        }

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
  }
}
