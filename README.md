# [WASM AI Video Compressor](https://wasm-video-compressor.coleswinford.workers.dev/)

A fully client-side, hardware-accelerated webapp that compresses video to exact target file sizes using WebCodecs and WebGPU

## Features

- **100% Local:** All processing happens on-device, ensuring zero server uploads
- **Two-Pass AI Budgeting:** Uses an ONNX WebGPU 224x224 classification model to analyze scene complexity and allocate bits efficiently
- **Hardware-Accelerated:** Utilizes native WebCodecs (`VideoEncoder`/`VideoDecoder`) for rapid, GPU-backed processing
- **Audio Passthrough:** Muxes raw original AAC tracks directly to the final file without quality loss
- **Accurate Target Sizes:** Enforces strict CBR rate control and a 5% container overhead deduction to hit exact MB targets
- **Color Accuracy:** Enforces standard Rec.709 SDR color space mapping to prevent washed-out outputs

## Setup

```bash
git clone [https://github.com/ColeSwinford/wasm-video-compressor.git](https://github.com/ColeSwinford/wasm-video-compressor.git)
cd wasm-video-compressor
npm install
npm run dev
```

## Build

``` bash
npx tsc --noEmit
npm run build
```
