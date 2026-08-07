export interface BlurShaderOptions {
  blurRadius?: number;
}

export class BackgroundBlurShader {
  private canvas: OffscreenCanvas | HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;

  // Dedicated Display-P3 2D canvas for hardware-accelerated HDR-to-SDR tone mapping & texture upload
  private hdrInput2dCanvas: OffscreenCanvas | HTMLCanvasElement;
  private hdrInput2dCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

  // 2D Output canvas wrapper to provide a valid 2D context for WebCodecs VideoFrame instantiation
  private output2dCanvas: OffscreenCanvas | HTMLCanvasElement;
  private output2dCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

  private videoTexture: WebGLTexture;
  private maskTexture: WebGLTexture;

  private positionBuffer: WebGLBuffer;
  private texCoordBuffer: WebGLBuffer;

  private uVideoLocation: WebGLUniformLocation;
  private uMaskLocation: WebGLUniformLocation;
  private uResolutionLocation: WebGLUniformLocation;
  private uBlurRadiusLocation: WebGLUniformLocation;

  private width = 0;
  private height = 0;
  private blurRadius: number;

  constructor(options: BlurShaderOptions = {}) {
    this.blurRadius = options.blurRadius || 4.0;

    if (typeof OffscreenCanvas !== 'undefined') {
      this.canvas = new OffscreenCanvas(1, 1);
      this.output2dCanvas = new OffscreenCanvas(1, 1);
      this.output2dCtx = this.output2dCanvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;

      this.hdrInput2dCanvas = new OffscreenCanvas(1, 1);
      this.hdrInput2dCtx = this.hdrInput2dCanvas.getContext('2d', { colorSpace: 'display-p3', willReadFrequently: false }) as OffscreenCanvasRenderingContext2D;
    } else {
      this.canvas = document.createElement('canvas');
      this.output2dCanvas = document.createElement('canvas');
      this.output2dCtx = this.output2dCanvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;

      this.hdrInput2dCanvas = document.createElement('canvas');
      this.hdrInput2dCtx = this.hdrInput2dCanvas.getContext('2d', { colorSpace: 'display-p3', willReadFrequently: false }) as CanvasRenderingContext2D;
    }

    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null;

    if (!gl) {
      throw new Error('WebGL2 rendering context is not supported in this browser.');
    }
    this.gl = gl;

    // 1. Create and compile Shaders
    const vsSource = `#version 300 es
      in vec2 a_position;
      in vec2 a_texCoord;
      out vec2 v_texCoord;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `;

    const fsSource = `#version 300 es
      precision highp float;
      in vec2 v_texCoord;
      
      uniform sampler2D u_videoTexture;
      uniform sampler2D u_maskTexture;
      uniform vec2 u_resolution;
      uniform float u_blurRadius;

      out vec4 fragColor;

      void main() {
        // Sample sharp video color
        vec4 sharpColor = texture(u_videoTexture, v_texCoord);

        // Sample AI saliency mask (0.0 = background, 1.0 = sharp subject)
        float maskVal = texture(u_maskTexture, v_texCoord).r;

        // Performant box blur over background pixels
        vec2 texelSize = 1.0 / u_resolution;
        vec4 blurredColor = vec4(0.0);
        float totalWeight = 0.0;

        for (int x = -4; x <= 4; x++) {
          for (int y = -4; y <= 4; y++) {
            vec2 offset = vec2(float(x), float(y)) * texelSize * u_blurRadius;
            blurredColor += texture(u_videoTexture, v_texCoord + offset);
            totalWeight += 1.0;
          }
        }
        blurredColor /= totalWeight;

        // Blend blurred background with sharp subject based on AI mask
        fragColor = mix(blurredColor, sharpColor, maskVal);
      }
    `;

    this.program = this.createProgram(vsSource, fsSource);

    // 2. Locate Attributes & Uniforms
    const aPosition = gl.getAttribLocation(this.program, 'a_position');
    const aTexCoord = gl.getAttribLocation(this.program, 'a_texCoord');

    this.uVideoLocation = gl.getUniformLocation(this.program, 'u_videoTexture')!;
    this.uMaskLocation = gl.getUniformLocation(this.program, 'u_maskTexture')!;
    this.uResolutionLocation = gl.getUniformLocation(this.program, 'u_resolution')!;
    this.uBlurRadiusLocation = gl.getUniformLocation(this.program, 'u_blurRadius')!;

    // 3. Setup Geometry Buffers (Full Screen Quad)
    this.positionBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1.0, -1.0,
         1.0, -1.0,
        -1.0,  1.0,
        -1.0,  1.0,
         1.0, -1.0,
         1.0,  1.0,
      ]),
      gl.STATIC_DRAW,
    );

    this.texCoordBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
    // Y-flipped texture coords for standard video orientation
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        0.0, 1.0,
        1.0, 1.0,
        0.0, 0.0,
        0.0, 0.0,
        1.0, 1.0,
        1.0, 0.0,
      ]),
      gl.STATIC_DRAW,
    );

    // 4. Create WebGL Textures
    this.videoTexture = this.createTexture();
    this.maskTexture = this.createTexture();

    // Setup VAO / Attributes
    gl.useProgram(this.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
    gl.enableVertexAttribArray(aTexCoord);
    gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 0, 0);
  }

  private createShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Failed to create WebGL shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`WebGL Shader Compilation Error: ${info}`);
    }
    return shader;
  }

  private createProgram(vsSource: string, fsSource: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.createShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.createShader(gl.FRAGMENT_SHADER, fsSource);
    const program = gl.createProgram();
    if (!program) throw new Error('Failed to create WebGL program');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      throw new Error(`WebGL Program Link Error: ${info}`);
    }
    return program;
  }

  private createTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to create WebGL texture');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return texture;
  }

  /**
   * Processes the original VideoFrame and 256x256 mask canvas through WebGL2 background blur shader.
   * Re-creates and returns a new WebCodecs VideoFrame containing the composite output.
   */
  public process(
    originalFrame: VideoFrame,
    maskCanvas: OffscreenCanvas | HTMLCanvasElement,
    targetWidth?: number,
    targetHeight?: number,
  ): VideoFrame {
    const gl = this.gl;
    const width = targetWidth || originalFrame.displayWidth;
    const height = targetHeight || originalFrame.displayHeight;

    // Resize canvas viewports if resolution changed
    if (this.width !== width || this.height !== height) {
      this.width = width;
      this.height = height;
      this.canvas.width = width;
      this.canvas.height = height;
      this.output2dCanvas.width = width;
      this.output2dCanvas.height = height;
      this.hdrInput2dCanvas.width = width;
      this.hdrInput2dCanvas.height = height;
      gl.viewport(0, 0, width, height);
    }

    // 1. Hardware GPU HDR-to-SDR Display-P3 2D Canvas Tone Mapping
    this.hdrInput2dCtx.drawImage(originalFrame, 0, 0, width, height);

    gl.useProgram(this.program);

    // 2. Upload Display-P3 2D Canvas to Texture Unit 0 (prevents color blowout & CPU stall)
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.hdrInput2dCanvas);
    gl.uniform1i(this.uVideoLocation, 0);

    // 3. Upload 256x256 Saliency Mask to Texture Unit 1
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
    gl.uniform1i(this.uMaskLocation, 1);

    // 4. Set Uniforms
    gl.uniform2f(this.uResolutionLocation, width, height);
    gl.uniform1f(this.uBlurRadiusLocation, this.blurRadius);

    // 5. Draw Quad onto WebGL2 canvas
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 6. Blit WebGL output to 2D canvas to guarantee a valid 2D context & colorSpace for WebCodecs VideoFrame
    this.output2dCtx.drawImage(this.canvas, 0, 0, width, height);

    // 7. Re-create new WebCodecs VideoFrame from 2D Canvas with non-null colorSpace
    const timestamp = originalFrame.timestamp;
    const duration = (originalFrame.duration !== null && originalFrame.duration !== undefined)
      ? originalFrame.duration
      : undefined;

    const initOptions: VideoFrameInit = {
      timestamp,
    };
    (initOptions as any).colorSpace = {
      primaries: 'bt709',
      transfer: 'bt709',
      matrix: 'bt709',
      fullRange: true,
    };
    if (duration !== undefined) {
      initOptions.duration = duration;
    }

    const compositeFrame = new VideoFrame(this.output2dCanvas, initOptions);

    return compositeFrame;
  }

  public getCanvas(): OffscreenCanvas | HTMLCanvasElement {
    return this.output2dCanvas;
  }

  public setBlurRadius(radius: number): void {
    this.blurRadius = radius;
  }
}
