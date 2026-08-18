import { defineConfig } from '@repo/tsdown';

export default defineConfig({
  entry: {
    runtime: 'src/exports/runtime.ts',
    'codec-lookup': 'src/exports/codec-lookup.ts',
  },
});
