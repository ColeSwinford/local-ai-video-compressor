import { defineConfig } from 'vite';

export default defineConfig({
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