import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

function resolveOnnxModelUrl(): string {
  const modelDir = resolve(import.meta.dirname, 'public/model');
  if (existsSync(modelDir)) {
    const onnxFile = readdirSync(modelDir).find((name) => name.toLowerCase().endsWith('.onnx'));
    if (onnxFile) {
      return `/model/${onnxFile}`;
    }
  }
  return '/model.onnx';
}

export default defineConfig({
  define: {
    __ONNX_MODEL_URL__: JSON.stringify(resolveOnnxModelUrl()),
  },
  plugins: [
    {
      name: 'strip-wasm-assets',
      generateBundle(_, bundle) {
        for (const fileName in bundle) {
          if (fileName.endsWith('.wasm')) {
            delete bundle[fileName];
          }
        }
      },
    },
  ],
});
