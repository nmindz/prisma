import { defineConfig } from '@repo/tsdown';

export default defineConfig({
  entry: {
    control: 'src/exports/control.ts',
    pack: 'src/exports/pack.ts',
    runtime: 'src/exports/runtime.ts',
    schema: 'src/exports/schema.ts',
    codecs: 'src/exports/codecs.ts',
    'codec-ids': 'src/exports/codec-ids.ts',
    ddl: 'src/exports/ddl.ts',
    contract: 'src/exports/contract.ts',
  },
});
