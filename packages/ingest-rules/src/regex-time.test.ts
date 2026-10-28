import { describe, expect, it } from "@effect/vitest"
import { compileIngestRegex, INGEST_RULE_LIMITS } from "@maple/domain/ingest-rules"
import { Option } from "effect"
import { findAll } from "./detectors"
import { scanCut } from "./engine"
import { pattern } from "./fuzz-arbitraries"

// The preview, MCP and local mode run patterns on a backtracking engine. Every pattern the
// validator accepts must scan a full window of hostile text quickly, or one rule can hang them.
// One repetition is quadratic at worst (~300ms); two overlapping ones take minutes. 30 patterns
// here; the differential fuzz in the ingest-rust job runs the JS engine over 20,000 more.

const FILLERS = ["a", "1", " ", "é", "x."]
const BUDGET_MS = 1500

describe("accepted patterns", () => {
	it.prop(
		"scan a full window of repetitive text within the budget",
		[pattern],
		([source]) => {
			const regex = Option.getOrThrow(compileIngestRegex(source))
			// Doubling lengths, so a cubic pattern fails within seconds instead of running for minutes.
			const slow = FILLERS.flatMap((filler) => {
				const full = filler.repeat(INGEST_RULE_LIMITS.scanBytes)
				const window = full.slice(0, scanCut(full))
				const lengths = [64, 128, 256, 512, 1024, 2048, 4096, 8192, window.length].filter(
					(length) => length <= window.length,
				)
				const over = lengths.reduce<{ length: number; elapsed: number } | null>((found, length) => {
					if (found !== null) return found
					const start = performance.now()
					findAll(regex, window.slice(0, length), () => true)
					const elapsed = performance.now() - start
					return elapsed > BUDGET_MS ? { length, elapsed } : null
				}, null)
				return over === null
					? []
					: [`${JSON.stringify(filler)} x ${over.length}: ${over.elapsed.toFixed(0)}ms`]
			})
			expect(slow).toEqual([])
		},
		{ timeout: 60_000, arbitrary: { runs: 30 } },
	)
})
