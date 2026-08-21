import { timeouts } from '@repo/test-utils';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: timeouts.typeScriptCompilation,
    hookTimeout: timeouts.vitestPackageDefault,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['dist/**', 'test/**', '**/*.test.ts', '**/*.config.ts', '**/exports/**'],
    },
  },
});
