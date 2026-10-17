/**
 * Dev entry: `bun run packages/ui-parity/src/backend/main.ts` serves the fixture backend on
 * PARITY_PORT_BASE + 0 (API) and + 3 (Electric) until interrupted.
 */
import { startBackend } from "./index.ts"

const base = Number(process.env.PARITY_PORT_BASE ?? "4790")
const startedAt = performance.now()
const backend = await startBackend({ apiPort: base, electricPort: base + 3 })

console.log(`ui-parity fixture backend ready in ${Math.round(performance.now() - startedAt)} ms`)
console.log(`  api       ${backend.apiOrigin}`)
console.log(`  electric  ${backend.electricOrigin}`)
console.log(`  datasets  ${backend.datasets.map((dataset) => dataset.name).join(", ")}`)

const shutdown = () => {
	void backend.close().then(() => process.exit(0))
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
