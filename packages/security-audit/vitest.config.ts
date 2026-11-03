import { defineConfig } from "vitest/config"

// The upstream `skill/*.test.cjs` suites run under `node --test` (see the `test` script).
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } })
