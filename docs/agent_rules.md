# Agent Rules & Guidelines

1. **Architecture & State Review**: Always review `docs/architecture.md` and `docs/state.md` before writing code.
2. **State Maintenance**: Update `docs/state.md` automatically whenever a new feature is successfully implemented.
3. **WebCodecs Strict Adherence**: Never use standard `ffmpeg.wasm`; strictly adhere to the WebCodecs API.
4. **Memory Management**: Ensure `frame.close()` is called on every `VideoFrame` immediately after consumption.
5. **Strict Typing**: Maintain strict TypeScript typing across all modules without unnecessary `any` overrides.
6. **Good Code**: If you need a paragraph-long comment to justify why the workaround is OK, the code is wrong--fix the code.
