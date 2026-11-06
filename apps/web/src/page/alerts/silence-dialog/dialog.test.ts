import { describe, expect, it } from "vitest"
import { Option } from "effect"
import { init, isFormReady, matchersOf, silenceEndMs } from "./dialog"

// 2026-11-06 14:20 in Berlin (UTC+1).
const NOW = Date.UTC(2026, 10, 6, 13, 20)
const BERLIN = "Europe/Berlin"

describe("silenceEndMs", () => {
	it("ends an hour or four hours from now", () => {
		expect(silenceEndMs("1h", "", NOW, BERLIN)).toEqual(Option.some(NOW + 60 * 60_000))
		expect(silenceEndMs("4h", "", NOW, BERLIN)).toEqual(Option.some(NOW + 4 * 60 * 60_000))
	})

	it("ends at 09:00 tomorrow on the viewer's wall clock", () => {
		expect(silenceEndMs("tomorrow", "", NOW, BERLIN)).toEqual(Option.some(Date.UTC(2026, 10, 7, 8, 0)))
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
		}
		expect(isFormReady({ ...model, until: "" })).toBe(false)
		expect(isFormReady({ ...model, until: "2026-11-07T09:00" })).toBe(true)
	})
})
