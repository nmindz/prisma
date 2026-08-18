import { defineConfig } from '@repo/tsdown';

export default defineConfig({
  entry: {
    index: 'src/exports/index.ts',
    types: 'src/exports/types.ts',
    'entity-kinds': 'src/exports/entity-kinds.ts',
  },
});
