/**
 * Parses each lockfile given on the command line and prints its package count and parse time.
 * Usage: bun lib/lockfiles/scripts/bench.ts bun.lock [more lockfiles...]
 */
import { readFileSync } from "node:fs"
import { Effect } from "effect"
import { parseLockfile } from "../src/index.ts"

const RUNS = 5

const benchOne = (path: string) =>
	Effect.gen(function* () {
		const content = readFileSync(path, "utf8")
		const timings = yield* Effect.forEach(Array.from({ length: RUNS }), () =>
			Effect.gen(function* () {
				const start = performance.now()
				const parsed = yield* parseLockfile({ path, content })
				return { parsed, ms: performance.now() - start }
			}),
		)
		const sorted = timings.map((t) => t.ms).sort((a, b) => a - b)
		const first = timings[0]
		if (first === undefined) return
		const { parsed } = first
		// Without manifests some formats (yarn) cannot tell direct dependencies apart.
		const direct = parsed.packages.some((p) => p.relation === "unknown")
			? "unknown"
			: String(parsed.packages.filter((p) => p.relation === "direct").length)
		yield* Effect.log(
			`${path}: ${parsed.kind}, ${parsed.packages.length} packages (${direct} direct), ${(content.length / 1024).toFixed(0)} KiB, ` +
				`first ${first.ms.toFixed(1)} ms, median ${(sorted[Math.floor(RUNS / 2)] ?? 0).toFixed(1)} ms over ${RUNS} runs` +
				(parsed.warnings.length > 0 ? `, warnings: ${parsed.warnings.join("; ")}` : ""),
		)
	})

const paths = process.argv.slice(2)
await Effect.runPromise(
	paths.length === 0
		? Effect.logError("usage: bun scripts/bench.ts <lockfile> [...]")
		: Effect.forEach(paths, benchOne, { discard: true }),
)
