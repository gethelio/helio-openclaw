import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  outDir: 'dist',
  // openclaw is a peer dependency supplied by the host gateway — never bundle it.
  external: ['openclaw'],
})
