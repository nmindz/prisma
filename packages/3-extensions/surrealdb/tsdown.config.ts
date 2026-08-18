import { defineConfig } from '@repo/tsdown';

export default defineConfig({
  entry: {
    config: 'src/exports/config.ts',
    control: 'src/exports/control.ts',
    runtime: 'src/exports/runtime.ts',
  },
});
