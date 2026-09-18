import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Server and shared code run in node; client tests opt into happy-dom per file.
    environment: 'node',
    // Integration/E2E tests talk to a real stack (login flows, provisioning): QA HIGH 2
    testTimeout: process.env['E2E'] === '1' ? 120_000 : 5_000,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts'],
  },
});
