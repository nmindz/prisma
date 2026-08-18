import { defineConfig } from '@repo/tsdown';

export default defineConfig({
  entry: {
    runtime: 'src/exports/runtime.ts',
    control: 'src/exports/control.ts',
  },
});
