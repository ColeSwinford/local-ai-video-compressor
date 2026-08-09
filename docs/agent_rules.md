# Agent Rules & Guidelines

1. **Architecture & State Review**: Always review `docs/architecture.md` and `docs/state.md` before writing or modifying code.
2. **State & Architecture Maintenance**: Automatically update `docs/state.md` when features are implemented and `docs/architecture.md` whenever directory structures or module interfaces change.
3. **Refactoring Scope**: During refactoring, strictly preserve existing business logic, user interface behavior, and API contracts. Do not alter functional behavior unless explicitly instructed.
4. **WebCodecs Strict Adherence**: Never use standard `ffmpeg.wasm`; strictly adhere to the browser-native WebCodecs API (`VideoEncoder`/`VideoDecoder`).
5. **Memory Management**: Ensure `frame.close()` is called on every `VideoFrame` immediately after consumption to prevent GPU memory leaks.
6. **Strict Typing**: Maintain strict TypeScript typing across all modules without using `any` or loose type overrides.
7. **Verification Required**: Before declaring any task complete, execute `npx tsc --noEmit` and `npm run build` to confirm zero compilation or type errors.
8. **Good Code**: If you need a paragraph-long comment to justify why a workaround is OK, the code is wrong—fix the code.
9. **Commit Notes Format**: Always output commit notes at the end of every response as unformatted plain text using the `\- <text here>` format.
