import { describe, expect, it } from "vitest"
import { Array as Arr, Option, Record, Schema, String as Str } from "effect"
import { migration_0075_retention_days } from "./clickhouse/migrations/0075_retention_days"
import { latestSnapshotStatements } from "./generated/clickhouse-schema"
import { tinybirdProjectManifest } from "./generated/tinybird-project-manifest"
import {
	DEFAULT_RETENTION_DAYS,
	hasRetentionOverrides,
	MAX_RETENTION_DAYS,
	organizationRetentionDays,
	readHorizonDays,
	RETENTION_SIGNAL_DATASOURCES,
	RETENTION_SIGNALS,
	RETENTION_PERIODS,
	RETENTION_TIME_COLUMNS,
	retentionStampDays,
	RetentionOverrides,
	sourceRetentionDays,
} from "./retention"

const manifestContent = (datasource: string): string | undefined =>
	Option.getOrUndefined(
		Arr.findFirst(tinybirdProjectManifest.datasources, (candidate) => candidate.name === datasource),
	)?.content

const rawTables = Arr.flatMap(RETENTION_SIGNALS, (signal) =>
	Arr.map(RETENTION_SIGNAL_DATASOURCES[signal], (datasource) => ({ signal, datasource }) as const),
)

const columnDefault = (datasource: string): number | undefined =>
	Option.getOrUndefined(
		Option.map(
			Option.fromNullishOr(
				/\bRetentionDays UInt16 [^\n]*DEFAULT (\d+)/.exec(manifestContent(datasource) ?? ""),
			),
			(match) => Number(match[1]),
		),
	)

describe("the RetentionDays column", () => {
	it("defaults to the signal's default period, so an unstamped row keeps what it kept before", () => {
		for (const { signal, datasource } of rawTables) {
			expect(columnDefault(datasource), datasource).toBe(DEFAULT_RETENTION_DAYS[signal])
		}
	})

	it("decides when each managed raw row expires, one period per partition", () => {
		for (const { datasource } of rawTables) {
			const day = `toDate(${RETENTION_TIME_COLUMNS[datasource]})`
			const content = manifestContent(datasource)
			expect(content, datasource).toContain(`ENGINE_PARTITION_KEY "(RetentionDays, ${day})"`)
			expect(content, datasource).toContain(`ENGINE_TTL "${day} + toIntervalDay(RetentionDays)"`)
			expect(content, datasource).toContain(`ENGINE_SETTINGS "ttl_only_drop_parts=1"`)
		}
	})

	it("leaves a self-managed table one period, its default, since nothing stamps it there", () => {
		for (const { signal, datasource } of rawTables) {
			const day = `toDate(${RETENTION_TIME_COLUMNS[datasource]})`
			const created = Arr.findFirst(latestSnapshotStatements, (statement) =>
				Str.startsWith(`CREATE TABLE IF NOT EXISTS ${datasource} (`)(statement),
			)
			const statement = Option.getOrUndefined(created)
			expect(statement, datasource).toContain(`\nPARTITION BY ${day}\n`)
			expect(statement, datasource).toContain(
				`\nTTL ${day} + INTERVAL ${DEFAULT_RETENTION_DAYS[signal]} DAY`,
			)
		}
	})

	it("is added to a self-managed cluster with the same default per table", () => {
		const migrated = Record.fromEntries(
			Arr.map(migration_0075_retention_days.statements, (statement) => {
				const match =
					/^ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS RetentionDays UInt16 DEFAULT (\d+)$/.exec(
						statement,
					)
				return [match?.[1] ?? statement, Number(match?.[2])] as const
			}),
		)
		// `product_events` came later, in migration 0076.
		const expected = Record.fromEntries(
			Arr.map(
				Arr.filter(rawTables, ({ datasource }) => datasource !== "product_events"),
				({ signal, datasource }) => [datasource, DEFAULT_RETENTION_DAYS[signal]] as const,
			),
		)
		expect(migrated).toEqual(expected)
		// A table listed twice would add its column with the first default and hide behind the second.
		expect(migration_0075_retention_days.statements).toHaveLength(Record.keys(expected).length)
	})
})

describe("retention time columns", () => {
	it("name the column each raw table's own expiry is keyed on", () => {
		for (const signal of RETENTION_SIGNALS) {
			for (const datasource of RETENTION_SIGNAL_DATASOURCES[signal]) {
				const found = Arr.findFirst(
					tinybirdProjectManifest.datasources,
					(candidate) => candidate.name === datasource,
				)
				expect(Option.getOrUndefined(found)?.content, datasource).toContain(
					`ENGINE_TTL "toDate(${RETENTION_TIME_COLUMNS[datasource]}) + `,
				)
			}
		}
	})
})

describe("retention stamp", () => {
	it("stores a period under the shortest ladder period that covers it", () => {
		expect(Arr.map([1, 3, 4, 30, 31, 45, 366, 551, MAX_RETENTION_DAYS, 800], retentionStampDays)).toEqual(
			[3, 3, 7, 30, 60, 60, 730, 730, 730, 730],
		)
	})

	it("stores every default under its own days, so an untouched org keeps nothing longer", () => {
		for (const signal of RETENTION_SIGNALS) {
			expect(retentionStampDays(DEFAULT_RETENTION_DAYS[signal]), signal).toBe(
				DEFAULT_RETENTION_DAYS[signal],
			)
		}
	})

	it("stores every period a policy can hold under exactly its own days", () => {
		for (const days of RETENTION_PERIODS) expect(retentionStampDays(days)).toBe(days)
	})

	it("never stores a period under fewer days than it asks for", () => {
		for (let days = 1; days <= MAX_RETENTION_DAYS; days++) {
			expect(retentionStampDays(days)).toBeGreaterThanOrEqual(days)
		}
	})
})

describe("retention resolution", () => {
	it("an organization overrides the default per signal", () => {
		expect(organizationRetentionDays({ traces: 60 })).toEqual({ ...DEFAULT_RETENTION_DAYS, traces: 60 })
	})

	it("a source's own period wins over the organization's, shorter or longer", () => {
		const days = sourceRetentionDays({ traces: 60, logs: 60 }, { traces: 3, logs: 365 })
		expect(days).toEqual({ ...DEFAULT_RETENTION_DAYS, traces: 3, logs: 365 })
	})

	it("a source with no period for a signal follows the organization, not the default", () => {
		expect(sourceRetentionDays({ metrics: 14 }, { traces: 3 }).metrics).toBe(14)
	})

	it("reads reach the longest source, and a shorter source does not pull them in", () => {
		const horizon = readHorizonDays({ traces: 60 }, [{ traces: 3 }, { traces: 365 }, { logs: 7 }])
		expect(horizon.traces).toBe(365)
		expect(horizon.logs).toBe(DEFAULT_RETENTION_DAYS.logs)
	})

	it("reaches as far as the period a stored off-list value is stamped with", () => {
		expect(readHorizonDays({ traces: 550 }, []).traces).toBe(730)
		expect(readHorizonDays({}, [{ logs: 45 }]).logs).toBe(60)
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

	it("accepts every period", () => {
		for (const days of RETENTION_PERIODS) expect(Option.isSome(decode({ traces: days }))).toBe(true)
	})

	it.each([
		["zero days", { traces: 0 }],
		["a day count between periods", { traces: 45 }],
		["past the maximum", { traces: MAX_RETENTION_DAYS + 1 }],
		["a fraction of a day", { traces: 1.5 }],
		["a string", { traces: "30" }],
	])("refuses %s", (_name, input) => {
		expect(Option.isNone(decode(input))).toBe(true)
	})
})
