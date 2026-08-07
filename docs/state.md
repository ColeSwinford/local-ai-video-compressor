# Current Project State

## Completed Stages & Features

- [x] **Vite TypeScript Scaffolding**: Initialized Vite project with `vanilla-ts` template, strict TypeScript configuration, and dependency setup (`mp4box`, `mp4-muxer`, `onnxruntime-web`, `@types/dom-webcodecs`).
- [x] **UI & Presentation Layer**: Built glassmorphism UI in `index.html` and `src/style.css` featuring drag & drop file upload, canvas output, status badge, metadata dashboard, download action button, and real-time event logging console.
- [x] **Rec.709 Standard SDR Color Enforcement (Fixes Washed Out Colors)**: Removed `{ colorSpace: 'display-p3' }` from canvas context initialization to default to standard `srgb`. Explicitly configured `VideoEncoder` and decoder metadata with `colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }`, forcing standard Rec.709 SDR color space mapping without washed-out clipping.
- [x] **5% MP4 Container Overhead Safety Margin (Fixes File Size Overshoot)**: Updated target bit calculation formula to calculate `safeTargetBits = totalTargetBits * 0.95`, reserving 5% of bit budget for MP4 container atoms, MOOV headers, and sample tables.
- [x] **Strict Constant Bitrate (CBR) Segment Allocation**: Updated `VideoEncoderConfig` and `reconfigureBitrate()` to enforce `bitrateMode: 'constant'` (CBR). Prevents hardware encoders (NVENC/QSV/VT) from drifting or exceeding target bitrates.
- [x] **Full ArrayBuffer Feeding Fix for QuickTime MOVs**: Loads and appends full file ArrayBuffer to `mp4box.js`, ensuring `onReady` and `setExtractionOptions` execute before sample parsing begins, resolving 0-sample extraction on QuickTime MOVs where `moov` is positioned after `mdat`.
- [x] **Multi-Tier VideoDecoder Fallback Recovery**: Added fallback configuration levels in `DecoderWrapper.configure()` (retrying without extradata description or with normalized HEVC codec strings if platform decoders reject initial parameters), enabling hardware decoding across HEVC and H.264 formats.
- [x] **Two-Pass AI Architecture for Guaranteed Target File Size**: Implemented `isAnalysisPass` state and `complexityMap` to execute Pass 1 (AI scene complexity scan) followed by Pass 2 (AI-guided CBR encoding).
- [x] **Pass 1 — AI Scene Complexity Scan**: Demuxes and decodes the source video, running ONNX WebGPU 224x224 classification every 15 frames and populating `complexityMap` with `{ timestamp, score }` entries without initializing `VideoEncoder`.
- [x] **Inter-Pass Bit Allocation Budgeting**: Calculates total score sum $S_{\text{total}}$, deducts audio footprint and 5% container overhead from target bits, and formulates exact per-segment target bitrates $\text{TargetBitrate}_i = \frac{\text{TargetVideoBits} \times (\text{score}_i / S_{\text{total}})}{\text{DurationSec}_i}$.
- [x] **Pass 2 — AI-Guided CBR Encoding**: Re-demuxes file from offset 0, queries `complexityMap` for pre-calculated CBR bitrates matching frame timestamps, dynamically reconfigures `VideoEncoder` on-the-fly (`encoderPipeline.reconfigureBitrate(targetBitrate)`), and encodes 1080p Rec.709 frames.
- [x] **Frozen Frame Bug Fix (Timestamp Passthrough)**: Re-creates 1080p `VideoFrame` instances from the 2D canvas with explicit `timestamp` and `duration` passthrough (`new VideoFrame(hdrCanvas, { timestamp: originalFrame.timestamp, duration: originalFrame.duration })`), preventing hardware encoder duplicate frame drops.
- [x] **ONNX 224x224 Scene Complexity Estimation (`src/complexity.ts`)**: Integrated ONNX WebGPU classification model with `createImageBitmap` 224x224 GPU downscaling and a 15-frame inference stride (`inferenceStride = 15`), producing a normalized `complexityScore` in `[0.0, 1.0]`.
- [x] **Dynamic 1080p Resolution Cap for 4K Inputs**: In `Demuxer.onReady`, checks if input resolution exceeds 1080p (width > 1920 or height > 1080). Calculates scaling ratio `Math.min(1920 / width, 1080 / height)` to strictly preserve aspect ratio with even dimensions (`Math.floor(x / 2) * 2`).
- [x] **DOM Binding & Listener Timing**: Wrapped DOM querying and event listener attachment inside `initApp()` executed on `DOMContentLoaded`. Verified matching IDs (`file-input`) between `index.html` and `src/main.ts`.
- [x] **Dynamic Scoping & File Selection Logging**: Target file size in MB is scoped and read dynamically inside the `change` and `drop` event listeners. Logged `"[System] Selected file: ..."` immediately upon file input change before starting the processing pipeline.
- [x] **Target File Size UI & Control**: Added a synchronized slider (`<input type="range" min="1" max="50">`) and numeric input (`<input type="number">`) allowing user to set exact target file size in MB (default 5 MB).
- [x] **MP4 Demuxing Module (`src/demuxer.ts`)**: Implemented ArrayBuffer File API demuxing with `mp4box.js`, `onReady` track parameter and extradata (`avcC`/`hvcC`) extraction, dual-track extraction (`videoTrack` + `audioTrack`), and chunk routing.
- [x] **Audio Passthrough Integration**: Raw `EncodedAudioChunk` instances are piped directly into `muxer.addAudioChunk()` without audio decoding/re-encoding, preserving pristine original audio.
- [x] **Strict Dual-Condition Pipeline Synchronization**: Eliminates finalization race conditions by tracking `info.nbSamples` declared in `onReady` and enforcing sequential flushing:
  1) `demuxer.demuxFile()` completes reading and demuxing all video and audio chunks.
  2) `currentDecoder.flush()` completes processing all frames through 2D canvas and `VideoEncoder`.
  3) `encoderPipeline.finalize()` flushes `VideoEncoder` and verifies encoded frame count equals expected sample count before `muxer.finalize()`.
- [x] **Finalization & Automatic File Export**: Flushes encoder (`await encoder.flush()`), finalizes MP4 muxer (`muxer.finalize()`), creates a Blob (`video/mp4`), generates an Object URL, and automatically triggers browser download of the processed video file with sound.
- [x] **Strict Dual-Frame Memory Safety**: Explicitly calls `.dispose()` on ONNX tensors, and calls `frame.close()` on both `originalFrame` and `processedFrame` every frame iteration to guarantee zero GPU/RAM memory leaks.
- [x] **Decoupled UI Execution Flow**: Decoupled file selection from immediate pipeline processing by adding a "Start Compression" button (`<button id="startBtn" disabled>`). File selection (`change` and `drop` events) sets `pendingFile`, logs `"[System] File selected, ready to compress"`, and enables `startBtn`. Clicking `startBtn` disables the button to prevent duplicate triggers and invokes `processFile(pendingFile)`.
- [x] **Build & Type Checking**: Verified clean compilation with `npx tsc --noEmit` and production build generation (`npm run build`). Dev server running locally at `http://localhost:5173/`.

---

## Current Status Overview
- **Active Stage**: Decoupled UI Execution Flow & Rec.709 Color Space / Strict CBR Enforcement Implemented.
- **Pipeline Output**: Fully functional, hardware-accelerated client-side video processing application producing target-compliant MP4 exports with preserved original audio tracks, rich Rec.709 SDR colors without washed-out artifacts, strict target file size adherence (with 5% overhead margin and CBR mode), Two-Pass AI complexity budgeting, and decoupled UI compression execution flow.
