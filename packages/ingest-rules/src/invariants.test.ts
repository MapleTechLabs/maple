import { describe, expect, it } from "@effect/vitest"
import { isProtectedKey, type IngestRuleSpec } from "@maple/domain/ingest-rules"
import type { Schema } from "effect"
import { isJsonObject, member, runCase, type FixtureCase } from "./conformance"
import { DETECTORS, findAll } from "./detectors"
import { scanCut } from "./engine"
import { fuzzCase, recordOf, SERVICES, type FuzzCase } from "./fuzz-arbitraries"

// Properties of the engine on random rules and records. scripts/fuzz.ts holds the gateway's
// engine to the same outcomes, so these hold there too.

const outcomeOf = (fixture: FixtureCase): Schema.JsonObject => {
	const outcome = runCase(fixture)
	expect(outcome).not.toHaveProperty("invalid")
	expect(isJsonObject(outcome)).toBe(true)
	return isJsonObject(outcome) ? outcome : {}
}

const withRules = (fixture: FuzzCase, rules: ReadonlyArray<IngestRuleSpec>): FuzzCase => ({
	...fixture,
	rules,
})

/** Every string in a JSON value, with the attribute key it sits under at the top level. */
const strings = (value: Schema.Json | undefined, key = ""): Array<readonly [string, string]> => {
	if (typeof value === "string") return [[key, value]]
	if (Array.isArray(value)) return value.flatMap((item) => strings(item, key))
	if (typeof value === "object" && value !== null)
		return Object.entries(value).flatMap(([inner, item]) => strings(item, key === "" ? inner : key))
	return []
}

const maskEmails = (fixture: FuzzCase): IngestRuleSpec => {
	const signal = fixture.input.signal
	return {
		signals: [signal],
		conditions: [],
		action: {
			_tag: "redact",
			keys: [],
			detectors: ["email"],
			patterns: [],
			scopes:
				signal === "logs"
					? ["attributes", "resource", "body"]
					: signal === "traces"
						? ["attributes", "resource", "events"]
						: ["attributes", "resource"],
			method: "mask",
		},
	}
}

describe("ingest rule invariants", () => {
	it.prop("keys Maple routes and bills on never change", [fuzzCase], ([fixture]) => {
		const outcome = outcomeOf(fixture)
		if (member(outcome, "dropped") === true) return
		for (const part of ["resource", "attributes"] as const) {
			const before = member(fixture.input, part)
			const after = member(outcome, part)
			for (const key of Object.keys(typeof before === "object" && before !== null ? before : {}).filter(
				isProtectedKey,
			))
				expect(member(after, key), `${part}.${key}`).toEqual(member(before, key))
		}
	})

	it.prop("masking emails leaves no email in the scanned text", [fuzzCase], ([fixture]) => {
		const outcome = outcomeOf(withRules(fixture, [maskEmails(fixture)]))
		const { regex, accept } = DETECTORS.email
		const eventList = member(outcome, "events")
		const events = Array.isArray(eventList) ? eventList.map((event) => member(event, "attributes")) : []
		const leaks = [
			member(outcome, "resource"),
			member(outcome, "attributes"),
			member(outcome, "body"),
			...events,
		]
			.flatMap((part) => strings(part))
			.filter(([key, text]) => !isProtectedKey(key) && text.length < 4096)
			.filter(([, text]) => findAll(regex, text.slice(0, scanCut(text)), accept).length > 0)
		expect(leaks).toEqual([])
	})

	// Custom patterns are left out: `\w+` also matches the `REDACTED` in its own mask.
	it.prop("unconditional key and detector masking is idempotent", [fuzzCase], ([fixture]) => {
		const rules = fixture.rules.flatMap((rule) =>
			rule.conditions.length === 0 &&
			rule.action._tag === "redact" &&
			rule.action.method !== "hash" &&
			rule.action.keys.length + rule.action.detectors.length > 0
				? [{ ...rule, action: { ...rule.action, patterns: [] } }]
				: [],
		)
		const once = outcomeOf(withRules(fixture, rules))
		const twice = outcomeOf({ ...withRules(fixture, rules), input: { ...fixture.input, ...once } })
		expect(twice).toEqual(once)
	})

	it.prop("rules for other signals leave the record untouched", [fuzzCase], ([fixture]) => {
		const others = fixture.rules.filter((rule) => !rule.signals.includes(fixture.input.signal))
		const outcome = outcomeOf(withRules(fixture, others))
		expect(member(outcome, "dropped")).toBe(false)
		expect(member(outcome, "resource")).toEqual(fixture.input.resource)
		expect(member(outcome, "attributes")).toEqual(fixture.input.attributes)
	})

	it.prop(
		"sampling keeps or drops every record of a trace together",
		[recordOf("logs"), recordOf("logs")],
		([first, second]) => {
			const traceId = "4bf92f3577b34da6a3ce929d0e0e4736"
			const sample = (keepPercent: number): IngestRuleSpec => ({
				signals: ["logs"],
				conditions: [{ field: "service_name", op: "in", values: [...SERVICES] }],
				action: { _tag: "drop", keepPercent },
			})
			for (const keep of [1, 37, 50, 99]) {
				const verdict = (input: Schema.JsonObject) =>
					outcomeOf({
						name: "trace",
						salt: "s",
						rules: [sample(keep)],
						input: { ...input, traceId },
					}).dropped
				expect(verdict(first)).toBe(verdict(second))
			}
		},
	)
})
