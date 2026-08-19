import { defineConfig } from '@repo/tsdown';

export default defineConfig({
  entry: {
    index: 'src/exports/index.ts',
    'config-types': 'src/exports/config-types.ts',
  },
});
