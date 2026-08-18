import { defineConfig } from '@repo/tsdown';

export default defineConfig({
  entry: {
    pack: 'src/exports/pack.ts',
    control: 'src/exports/control.ts',
  },
});
