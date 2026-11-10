import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * One alias, and nothing else.
 *
 * The dashboard had no vitest config, so every test lived in `src/lib/` and
 * imported relatively. Anything importing `@/...` was unreachable from a
 * test, which is why the admin server actions had no coverage. This adds the
 * same `@/*` mapping `tsconfig.json` already declares. No new dependency: the
 * root workspace already carries vitest.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
