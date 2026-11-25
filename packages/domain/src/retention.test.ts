import { describe, expect, it } from "vitest"
import { Array as Arr, Option, Schema } from "effect"
import { tinybirdProjectManifest } from "./generated/tinybird-project-manifest"
import {
	DEFAULT_RETENTION_DAYS,
	hasRetentionOverrides,
	MAX_RETENTION_DAYS,
	organizationRetentionDays,
	readHorizonDays,
	RETENTION_SIGNAL_DATASOURCES,
	RETENTION_SIGNALS,
	RetentionOverrides,
	sourceRetentionDays,
} from "./retention"

const ttlDays = (datasource: string): number | undefined =>
	Option.getOrUndefined(
		Option.flatMap(
			Arr.findFirst(tinybirdProjectManifest.datasources, (candidate) => candidate.name === datasource),
			(found) =>
				Option.map(
					Option.fromNullishOr(/ENGINE_TTL "[^"]+ \+ INTERVAL (\d+) DAY"/.exec(found.content)),
					(match) => Number(match[1]),
				),
		),
	)

describe("retention defaults", () => {
	it("match what every raw table of the signal keeps today", () => {
		for (const signal of RETENTION_SIGNALS) {
			for (const datasource of RETENTION_SIGNAL_DATASOURCES[signal]) {
				expect(ttlDays(datasource), `${signal}: ${datasource}`).toBe(DEFAULT_RETENTION_DAYS[signal])
			}
		}
	})
})

describe("retention resolution", () => {
	it("an organization overrides the default per signal", () => {
		expect(organizationRetentionDays({ traces: 45 })).toEqual({ ...DEFAULT_RETENTION_DAYS, traces: 45 })
	})

	it("a source's own period wins over the organization's, shorter or longer", () => {
		const days = sourceRetentionDays({ traces: 45, logs: 60 }, { traces: 3, logs: 400 })
		expect(days).toEqual({ ...DEFAULT_RETENTION_DAYS, traces: 3, logs: 400 })
	})

	it("a source with no period for a signal follows the organization, not the default", () => {
		expect(sourceRetentionDays({ metrics: 14 }, { traces: 3 }).metrics).toBe(14)
	})

	it("reads reach the longest source, and a shorter source does not pull them in", () => {
		const horizon = readHorizonDays({ traces: 45 }, [{ traces: 3 }, { traces: 400 }, { logs: 7 }])
		expect(horizon.traces).toBe(400)
		expect(horizon.logs).toBe(DEFAULT_RETENTION_DAYS.logs)
	})

	it("shortening the organization shortens reads when no source keeps more", () => {
		expect(readHorizonDays({ logs: 7 }, [{ traces: 3 }]).logs).toBe(7)
	})

	it("tells an override that sets nothing from one that sets a signal", () => {
		expect(hasRetentionOverrides({})).toBe(false)
		expect(hasRetentionOverrides({ profiles: 30 })).toBe(true)
	})
})

describe("RetentionOverrides", () => {
	const decode = Schema.decodeUnknownOption(RetentionOverrides)

	it("accepts whole days up to the maximum", () => {
		expect(Option.isSome(decode({ traces: 1, logs: MAX_RETENTION_DAYS }))).toBe(true)
	})

	it.each([
		["zero days", { traces: 0 }],
		["past the maximum", { traces: MAX_RETENTION_DAYS + 1 }],
		["a fraction of a day", { traces: 1.5 }],
		["a string", { traces: "30" }],
	])("refuses %s", (_name, input) => {
		expect(Option.isNone(decode(input))).toBe(true)
	})
})
