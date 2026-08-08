# Current Project State

## Active Pipeline Overview
- Client-side two-pass video compression using WebCodecs, WebGPU ONNX scene complexity analysis, and `mp4-muxer`.
- Single static configuration rate control per encoding pass to prevent GPU driver (NVENC/AMD) bitrate panics.
- Audio passthrough preserving raw AAC track bytes.

## Supported Formats & Codecs
- Container: MP4, MOV (QuickTime MOVs supported via full ArrayBuffer demuxing).
- Video Codecs: H.264 / AVC (High Profile), HEVC decoding support.
- Color Space: Rec.709 SDR mapping.