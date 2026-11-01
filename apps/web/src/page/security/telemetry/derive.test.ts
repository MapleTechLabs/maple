import { describe, expect, it } from "@effect/vitest"
import { Arbitrary, Schema } from "effect"
import { criticalUpgrades, runtimeEntries, runtimeTotals } from "./derive"
import type { Runtimes } from "./model"

// Fuzzes the Runtimes tab over random fleets: services that upgraded, rolled back, run mixed
// versions or stopped reporting. Small value pools make collisions (same service, same hour) common.

const HOUR_MS = 3_600_000
const WINDOW_START = Date.parse("2026-10-25T00:00:00.000Z")

// Bun, Node.js and Bun posing as Node.js, on versions with critical, high or no advisories.
const Runtime = Schema.Literals([
	"bun 1.4.0",
	"bun 1.4.4",
	"bun 1.3.9",
	"bun ",
	"nodejs 22.4.0",
	"nodejs 22.11.0",
	"workerd ",
])

const RowSeed = Schema.Struct({
	service: Schema.Literals(["api", "scraper", "web"]),
	environment: Schema.Literals(["production", "staging", ""]),
	runtime: Runtime,
	executableName: Schema.Literals(["node", "bun"]),
	sdkVersion: Schema.Literals(["", "4.0.4", "4.1.0"]),
	/** Hours into the 7-day window of the last hour seen. */
	hour: Schema.Literals([0, 1, 2, 30, 160, 167]),
	spans: Schema.Literals([1, 500, 80_000]),
})
type RowSeed = typeof RowSeed.Type
type Row = Runtimes["runtimes"][number]

const ADVISORY_KEYS = ["bun@1.4.0", "bun@1.3.9", "bun@1.4.4", "nodejs@22.4.0", "nodejs@22.11.0"] as const

const advisory = (id: string, severity: "critical" | "high" | "medium") => ({
	id,
	url: `https://example.test/${id}`,
	summary: null,
	severity,
	fixedIn: null,
	published: null,
})

const ADVISORIES: Runtimes["advisories"] = {
	"bun@1.4.0": [advisory("GHSA-1", "high"), advisory("GHSA-2", "high")],
	"bun@1.3.9": [advisory("GHSA-3", "critical")],
	"bun@1.4.4": [],
	"nodejs@22.4.0": [advisory("CVE-1", "high"), advisory("CVE-2", "medium")],
	"nodejs@22.11.0": [],
}

const RELEASES: Runtimes["releases"] = {
	bun: [
		{ cycle: "1.4", isEol: false, eolFrom: null, latest: "1.4.4" },
		{ cycle: "1.3", isEol: true, eolFrom: "2026-06-01", latest: "1.3.9" },
	],
	nodejs: [{ cycle: "22", isEol: false, eolFrom: null, latest: "22.11.0" }],
}

const toRow = (seed: RowSeed): Row => {
	const [runtimeName = "", runtimeVersion = ""] = seed.runtime.split(" ")
	return {
		service: seed.service,
		environment: seed.environment,
		runtimeName,
		runtimeVersion,
		executableName: seed.executableName,
		sdkLanguage: "nodejs",
		sdkName: seed.sdkVersion === "" ? "" : "effect",
		sdkVersion: seed.sdkVersion,
		spans: seed.spans,
		lastSeen: new Date(WINDOW_START + seed.hour * HOUR_MS).toISOString(),
	}
}

const comboKey = (row: Row) =>
	JSON.stringify([
		row.service,
		row.environment,
		row.runtimeName,
		row.runtimeVersion,
		row.executableName,
		row.sdkName,
		row.sdkVersion,
	])
const deploymentKey = (row: Row) => JSON.stringify([row.service, row.environment])

// The query groups by the full combination, so a response never repeats one.
const dedupe = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> => [
	...new Map(rows.map((row) => [comboKey(row), row] as const).reverse()).values(),
]

const runtimesOf = (rows: ReadonlyArray<Row>, skipped: ReadonlyArray<string>): Runtimes => ({
	runtimes: rows,
	releases: RELEASES,
	advisories: Object.fromEntries(Object.entries(ADVISORIES).filter(([key]) => !skipped.includes(key))),
	advisoriesSkipped: skipped,
})

const World = Arbitrary.map(
	Arbitrary.schema(
		Schema.Struct({
			rows: Schema.Array(RowSeed),
			skipped: Schema.Array(Schema.Literals(ADVISORY_KEYS)),
		}),
	),
	({ rows, skipped }) => runtimesOf(dedupe(rows.map(toRow)), [...new Set(skipped)]),
)

/** What the page tells the user to act on: the stat rail and the "upgrade now" list. */
const verdict = (runtimes: Runtimes) => {
	const entries = runtimeEntries(runtimes)
	return {
		totals: runtimeTotals(entries),
		upgrades: criticalUpgrades(entries)
			.map((upgrade) => ({ key: upgrade.key, services: [...upgrade.services].sort() }))
			.sort((a, b) => a.key.localeCompare(b.key)),
	}
}

const newestHourOf = (rows: ReadonlyArray<Row>) =>
	rows.reduce(
		(newest, row) =>
			newest.set(
				deploymentKey(row),
				Math.max(newest.get(deploymentKey(row)) ?? 0, Date.parse(row.lastSeen)),
			),
		new Map<string, number>(),
	)

describe("runtime verdicts", () => {
	it.prop(
		"a version a service upgraded away from changes nothing the page asks you to fix",
		[World, RowSeed],
		([runtimes, seed]) => {
			const base = runtimes.runtimes.find((row) => deploymentKey(row) === deploymentKey(toRow(seed)))
			if (base === undefined) return
			// The same deployment, on any version, last seen strictly before its newest hour.
			const older: Row = {
				...toRow(seed),
				sdkVersion: "0.0.0-older",
				lastSeen: new Date(
					newestHourOf(runtimes.runtimes).get(deploymentKey(base))! - HOUR_MS,
				).toISOString(),
			}
			const withHistory = { ...runtimes, runtimes: [...runtimes.runtimes, older] }
			expect(verdict(withHistory)).toEqual(verdict(runtimes))
		},
	)

	it.prop(
		"the row order of the response changes nothing",
		[World, Schema.Array(Schema.Finite)],
		([runtimes, keys]) => {
			const shuffled = runtimes.runtimes
				.map((row, index) => ({ row, key: keys[index % Math.max(keys.length, 1)] ?? index }))
				.sort((a, b) => a.key - b.key)
				.map(({ row }) => row)
			expect(verdict({ ...runtimes, runtimes: shuffled })).toEqual(verdict(runtimes))
		},
	)

	it.prop(
		"every row shows once, and each deployment keeps its newest rows current",
		[World],
		([runtimes]) => {
			const entries = runtimeEntries(runtimes)
			expect(entries.map((entry) => comboKey(entry.row)).sort()).toEqual(
				runtimes.runtimes.map(comboKey).sort(),
			)
			const newest = newestHourOf(runtimes.runtimes)
			entries.forEach((entry) => {
				expect(entry.replaced).toBe(
					Date.parse(entry.row.lastSeen) < newest.get(deploymentKey(entry.row))!,
				)
			})
			// History sits below everything current.
			const firstReplaced = entries.findIndex((entry) => entry.replaced)
			expect(
				firstReplaced === -1 || entries.slice(firstReplaced).every((entry) => entry.replaced),
			).toBe(true)
		},
	)

	it.prop("the stat rail and the upgrade list agree", [World], ([runtimes]) => {
		const { totals, upgrades } = verdict(runtimes)
		const upgradeServices = new Set(upgrades.flatMap((upgrade) => upgrade.services))
		expect(totals.urgent).toBe(upgradeServices.size)
		expect(totals.services).toBe(new Set(runtimes.runtimes.map((row) => row.service)).size)
		for (const count of [totals.urgent, totals.endOfLife, totals.behind, totals.noVersion])
			expect(count).toBeLessThanOrEqual(totals.services)
	})

	it("drops the scraper's Bun 1.4.0 once 1.4.4 took over (prd, 2026-11-01)", () => {
		const scraper = (runtimeVersion: string, lastSeen: string): Row => ({
			service: "scraper",
			environment: "production",
			runtimeName: "bun",
			runtimeVersion,
			executableName: "bun",
			sdkLanguage: "nodejs",
			sdkName: "",
			sdkVersion: "",
			spans: 1,
			lastSeen,
		})
		const runtimes = runtimesOf(
			[scraper("1.4.0", "2026-11-01T14:00:00.000Z"), scraper("1.4.4", "2026-11-01T17:00:00.000Z")],
			[],
		)
		expect(verdict(runtimes)).toEqual({
			totals: { services: 1, urgent: 0, endOfLife: 0, behind: 0, noVersion: 0 },
			upgrades: [],
		})
	})
})
