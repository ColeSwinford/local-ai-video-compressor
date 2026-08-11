# [Local AI Video Compressor](https://video-compressor.coleswinford.com/)

A privacy-first, fully client-side web application that compresses videos to exact target file sizes. Built with **TypeScript**, **WebCodecs**, and **WebAssembly**, it eliminates the need for server-side processing by utilizing edge-deployed machine learning and local hardware acceleration.

[![Live Demo](https://img.shields.io/badge/Live-Demo-brightgreen.svg)](https://video-compressor.coleswinford.com/)
[![Tech Stack](https://img.shields.io/badge/Stack-TypeScript%20%7C%20Vite%20%7C%20WebCodecs-blue.svg)]()

<p align="center">
  <img src="docs/assets/video-compressor.png" alt="Local AI Video Compressor Interface" width="100%" />
</p>

## 🧠 The Problem & Solution

**The Problem:** Traditional web-based video compressors rely on uploading files to a remote server. This introduces massive latency, incurs high cloud compute costs, and compromises user privacy. 

**The Solution:** This application offloads the entire computational workload to the client's device. By leveraging modern browser APIs (WebCodecs) and in-browser machine learning (ONNX Runtime), it delivers native-speed video processing with zero network overhead and strict data privacy.

## ⚙️ Technical Architecture

- **Two-Pass AI Budgeting (WASM / WebGPU):** Utilizes an ONNX 224x224 classification model running via WebAssembly to analyze frame-by-frame scene complexity. This allows the encoder to dynamically allocate bitrates—saving space on static scenes and preserving quality during high motion.
- **Hardware-Accelerated Processing:** Bypasses slow software encoders by tapping directly into the device's native GPU/CPU video blocks via the `VideoEncoder` and `VideoDecoder` WebCodecs APIs.
- **Strict Bitrate Control:** Enforces precise Constant Bitrate (CBR) control and calculates a strict 5% container overhead deduction to ensure the final output never exceeds the user's exact MB target (e.g., Discord's strict 8MB limit).
- **Lossless Audio Passthrough:** Demuxes and remuxes the original raw AAC audio tracks directly into the final container, completely bypassing audio re-encoding to eliminate generation loss and audio drift.
- **Color Space Preservation:** Enforces standard Rec.709 SDR color space mapping to prevent the washed-out color shifting common in browser-based canvas manipulation.

## 🛠️ Tech Stack

- **Language:** TypeScript
- **Bundler:** Vite
- **Media Processing:** WebCodecs API, `mp4box.js`
- **Machine Learning:** ONNX Runtime Web, WebAssembly (WASM)
- **Deployment:** Cloudflare Workers / Pages

## 🚀 Running Locally

To run this project locally for development or testing:

1. Clone the repository:
   ```bash
   git clone [https://github.com/coleswinford/local-ai-video-compressor.git](https://github.com/coleswinford/local-ai-video-compressor.git)
   cd local-ai-video-compressor
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

4. Build for production:
   ```bash
   npm run build
   ```