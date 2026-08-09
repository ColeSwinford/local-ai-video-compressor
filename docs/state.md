# Current Project State

## Project Identity
- Repository Name: `local-ai-video-compressor`
- Target Environment: Client-side webapp (TypeScript, Vite, Cloudflare Pages/Workers)
- Production URL: `https://video-compressor.coleswinford.com`

## Active Pipeline & Architecture
- **Two-Pass Compression**: Client-side execution using WebCodecs (`VideoEncoder`/`VideoDecoder`), WebGPU/WASM ONNX scene complexity analysis, and `mp4-muxer`.
- **Pass 1 (Analysis)**: Runs an ONNX 224x224 classification model across video frames to generate a timestamped complexity map.
- **Pass 2 (Encoding)**: Dynamic VBR allocation based on Pass 1 weights, applying a strict 5% container overhead deduction to ensure exact target MB compliance.
- **Audio Passthrough**: Demuxes and remuxes raw AAC tracks directly into the output container without audio re-encoding.
- **Color Space**: Enforces standard Rec.709 SDR color space mapping.

## UI & UX Features
- **Header Status & Progress**: Progress bar tracks frame completion ratio smoothly across Pass 1 (0–50%) and Pass 2 (50–100%).
- **Mobile Responsive Header**: Hides `.window-title` on viewports under 520px and applies text truncation (`ellipsis`) to status badges to prevent UI overlap.
- **Architecture & Privacy Modal**: Accessible header info button ("?") triggering an overlay modal detailing 100% on-device processing and two-pass AI mechanics.

## Directory Structure & Refactor State
- `src/pipeline/`: Core compression stages (`compressor.ts`, `complexity.ts`, `demuxer.ts`, `encoder.ts`).
- `src/ui/`: DOM components (`modal.ts`, `progress.ts`).
- `src/utils/`: Pure helper functions (`formatters.ts`, `dimensions.ts`).
- `src/types/`: Centralized interfaces (`index.ts`).
- `src/styles/`: Modular stylesheets (`base.css`, `window.css`, `dropzone.css`, `modal.css`) aggregated in `src/style.css`.
- `src/main.ts`: Clean entry point restricted to event wiring and execution triggers.

## Supported Formats & Codecs
- Containers: MP4, MOV (QuickTime MOVs supported via ArrayBuffer demuxing).
- Video Codecs: H.264 / AVC output, HEVC decoding support.