import { describe, expect, it } from "vitest"
import { Option } from "effect"
import { init, isFormReady, matchersOf, silenceEndMs, untilError } from "./dialog"

// 2026-11-06 14:20 in Berlin (UTC+1).
const NOW = Date.UTC(2026, 10, 6, 13, 20)
const BERLIN = "Europe/Berlin"

describe("silenceEndMs", () => {
	it("ends an hour or four hours from now", () => {
		expect(silenceEndMs("1h", "", NOW, BERLIN)).toEqual(Option.some(NOW + 60 * 60_000))
		expect(silenceEndMs("4h", "", NOW, BERLIN)).toEqual(Option.some(NOW + 4 * 60 * 60_000))
	})

	it("ends at the next 09:00 on the viewer's wall clock", () => {
		expect(silenceEndMs("morning", "", NOW, BERLIN)).toEqual(Option.some(Date.UTC(2026, 10, 7, 8, 0)))
		// At 00:30 the next 09:00 is this morning's, and across a month's end it rolls over.
		expect(silenceEndMs("morning", "", Date.UTC(2026, 9, 31, 23, 30), BERLIN)).toEqual(
			Option.some(Date.UTC(2026, 10, 1, 8, 0)),
		)
		// Across the DST change (Berlin falls back on 2026-10-25): 09:00 CET, not CEST.
		expect(silenceEndMs("morning", "", Date.UTC(2026, 9, 24, 20, 0), BERLIN)).toEqual(
			Option.some(Date.UTC(2026, 9, 25, 8, 0)),
		)
	})

	it("reads a custom end in the viewer's zone and refuses one in the past", () => {
		expect(silenceEndMs("custom", "2026-11-06T18:30", NOW, BERLIN)).toEqual(
			Option.some(Date.UTC(2026, 10, 6, 17, 30)),
		)
		expect(silenceEndMs("custom", "2026-11-06T09:00", NOW, BERLIN)).toEqual(Option.none())
		expect(silenceEndMs("custom", "tomorrow", NOW, BERLIN)).toEqual(Option.none())
	})
})

describe("matchersOf", () => {
	it("splits typed lists and drops empty fields", () => {
		expect(
			matchersOf({
				_tag: "Typed",
				services: " checkout, payments ,checkout",
				tags: "",
				environments: "production",
			}),
		).toEqual({ services: ["checkout", "payments"], environments: ["production"] })
	})
})

describe("isFormReady", () => {
	const typed = (services: string) => ({ _tag: "Typed" as const, services, tags: "", environments: "" })

	it("needs a reason and something to match", () => {
		const model = init("silence")
		expect(isFormReady({ ...model, reason: "deploy", scope: typed("") })).toBe(false)
		expect(isFormReady({ ...model, reason: " ", scope: typed("checkout") })).toBe(false)
		expect(isFormReady({ ...model, reason: "deploy", scope: typed("checkout") })).toBe(true)
	})

	it("needs a readable end for a custom duration", () => {
		const model = {
			...init("silence"),
			reason: "deploy",
			scope: typed("checkout"),
			duration: "custom" as const,
			timeZone: BERLIN,
			nowMs: NOW,
		}
		expect(isFormReady({ ...model, until: "" })).toBe(false)
		expect(isFormReady({ ...model, until: "2026-11-07T09:00" })).toBe(true)
		expect(isFormReady({ ...model, until: "2026-11-06T09:00" })).toBe(false)
		expect(untilError({ ...model, until: "2026-11-06T09:00" })).toEqual(
			Option.some("Pick a time in the future"),
		)
		expect(isFormReady({ ...model, until: "2026-12-24T09:00" })).toBe(false)
		expect(untilError({ ...model, until: "2026-12-24T09:00" })).toEqual(
			Option.some("A silence can last at most 30 days"),
		)
	})
})
