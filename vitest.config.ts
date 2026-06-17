import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Per plan: the typecheck against the real SDK event types is part of the test.
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
      include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    },
  },
})
