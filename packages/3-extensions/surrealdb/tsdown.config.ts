import { defineConfig } from '@repo/tsdown';

export default defineConfig({
  entry: {
    config: 'src/exports/config.ts',
    'contract-builder': 'src/exports/contract-builder.ts',
    control: 'src/exports/control.ts',
    runtime: 'src/exports/runtime.ts',
  },
});
