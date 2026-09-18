import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Server and shared code run in node; client tests opt into happy-dom per file.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts'],
  },
});
