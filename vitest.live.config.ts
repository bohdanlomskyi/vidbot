import { defineConfig } from 'vitest/config';

// Live tests talk to real external services. They are skipped unless the
// matching environment flags are set; see tests/live/README.md.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live/**/*.live.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
