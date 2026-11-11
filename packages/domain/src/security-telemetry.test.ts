import { describe, expect, it } from "vitest"
import {
	PROBE_CATEGORIES,
	PROBE_SIGNATURES,
	SCANNER_AGENTS,
	type SourceActivity,
	attackChainReasons,
	attackStagesOf,
	probeCategoryOf,
} from "./security-telemetry"
import { Array as Arr, String as Str } from "effect"

describe("probe catalog", () => {
	it("never lists a token inside another", () => {
		// multiSearchFirstIndex picks the leftmost match, so an overlapping pair could file one
		// probe under the other's category.
		for (const list of [PROBE_SIGNATURES, SCANNER_AGENTS]) {
			const tokens = Arr.map(list, (entry) => Str.toLowerCase(entry.token))
			for (const token of tokens) {
				expect(Arr.filter(tokens, (other) => other !== token && Str.includes(token)(other))).toEqual(
					[],
				)
			}
		}
	})

	it("files every signature under a listed category", () => {
		const categories = new Set(Arr.map(PROBE_CATEGORIES, (category) => category.id))
		const filed = Arr.map(PROBE_SIGNATURES, (signature) => probeCategoryOf(signature.token))
		expect(Arr.filter(filed, (category) => category === undefined || !categories.has(category))).toEqual(
			[],
		)
		expect(probeCategoryOf("")).toBeUndefined()
	})
})

describe("attack chains", () => {
	const quiet = { probed: [], denied: 0, passedDenialSeconds: 0 }
	const chain = (source: SourceActivity, agent = "") =>
		attackChainReasons({ agent, stages: attackStagesOf(source) }).length > 0

	it("needs every stage: a sweep with exploit paths that stops at the refusal is not a chain", () => {
		const sweep = { ...quiet, probed: ["/.env", "/.git/", "/actuator/env", "../"] }
		expect(attackStagesOf(sweep)).toEqual(["sweep", "exploit"])
		expect(chain(sweep)).toBe(false)
		const persisting = { ...sweep, denied: 4, passedDenialSeconds: 300 }
		expect(attackStagesOf(persisting)).toEqual(["sweep", "exploit", "persisted"])
		expect(chain(persisting)).toBe(true)
	})

	it("counts persistence only when a request got through a minute or more after a refusal", () => {
		const probes = ["../"]
		expect(attackStagesOf({ probed: probes, denied: 3, passedDenialSeconds: 5 })).toEqual(["exploit"])
		// No answered request after the refusal: dateDiff to an empty maxIf is negative.
		expect(attackStagesOf({ probed: probes, denied: 3, passedDenialSeconds: -1_000_000 })).toEqual([
			"exploit",
		])
		expect(attackStagesOf({ ...quiet, passedDenialSeconds: 9999 })).toEqual([])
	})

	it("marks a source on an autonomous agent's user agent alone, and says why", () => {
		expect(attackChainReasons({ agent: "ARTEX", stages: [] })).toEqual(["sent the ARTEX user agent"])
		expect(attackChainReasons({ agent: "", stages: ["sweep", "exploit"] })).toEqual([])
		expect(attackChainReasons({})).toEqual([])
	})
})
