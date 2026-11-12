import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_PATH = resolve(__dirname, '../public/model/mobilenetv2-12.onnx');
const MODEL_URL =
  'https://github.com/onnx/models/raw/main/validated/vision/classification/mobilenet/model/mobilenetv2-12.onnx';
const MIN_EXPECTED_BYTES = 1_000_000;

async function main() {
  if (existsSync(TARGET_PATH) && statSync(TARGET_PATH).size >= MIN_EXPECTED_BYTES) {
    const sizeMb = (statSync(TARGET_PATH).size / (1024 * 1024)).toFixed(2);
    console.log(`[download-model] public/model.onnx already present (${sizeMb} MB).`);
    return;
  }

  console.log(`[download-model] Downloading MobileNetV2 ONNX model from ${MODEL_URL}...`);
  const response = await fetch(MODEL_URL, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to download model (${response.status} ${response.statusText})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength < MIN_EXPECTED_BYTES) {
    throw new Error(`Downloaded model is unexpectedly small (${buffer.byteLength} bytes).`);
  }

  mkdirSync(dirname(TARGET_PATH), { recursive: true });
  writeFileSync(TARGET_PATH, buffer);

  const sizeMb = (buffer.byteLength / (1024 * 1024)).toFixed(2);
  console.log(`[download-model] Saved public/model.onnx (${sizeMb} MB).`);
}

main().catch((err) => {
  console.error('[download-model] Error:', err?.message || err);
  process.exit(1);
});
