// SAFETY-FILE: JSON in this test is emitted by ClickHouse for the queries under test before its fields are asserted.
// Cost reads against real rows. `cost_daily` is versioned by pull, not deduplicated by key, so the
// compiled SQL alone cannot show that a restated day replaces the older pull. Seeded to catch:
//   - a key the provider dropped on restatement still counting (argMax per key would keep it),
//   - an ingest retry's copy of a row counting twice,
//   - a disconnected source's rows counting once the caller names the active sources,
//   - the sync's zero marker row for an emptied day showing as a key of its own.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Effect, Array as Arr, String as Str } from "effect"
import { OrgId } from "@maple/domain"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "../../testing/clickhouse-e2e-support"

const database = uniqueDatabase("maple_cost_daily_e2e")
const ORG_ID = OrgId.make("org_cost_daily")
const DAY_MS = 86_400_000

const chDateTime = (epochMs: number): string =>
	Str.slice(0, 19)(Str.replace("T", " ")(new Date(epochMs).toISOString()))

/** Midnight five days back; day 0 to 2 are the window, day -3 to -1 the period before it. */
const BASE_MS = Math.floor((Date.now() - 5 * DAY_MS) / DAY_MS) * DAY_MS
const day = (offset: number): string => chDateTime(BASE_MS + offset * DAY_MS)

const FIRST_PULL = chDateTime(BASE_MS + 3 * DAY_MS)
const SECOND_PULL = chDateTime(BASE_MS + 4 * DAY_MS)

const params = {
	orgId: ORG_ID,
	previousStartDate: day(-3),
	startDate: day(0),
	endDate: day(2),
}

interface SeedRow {
	readonly source: string
	readonly day: number
	readonly service: string
	readonly region: string
	readonly billed: number
	readonly effective?: number
	readonly estimated?: boolean
	readonly pulledAt: string
	/** The sync's zero row for a day a pull returned nothing for: every string empty. */
	readonly marker?: boolean
}

const row = (
	source: string,
	dayOffset: number,
	service: string,
	region: string,
	billed: number,
	pulledAt: string,
	extra: { readonly effective?: number; readonly estimated?: boolean } = {},
): SeedRow => ({ source, day: dayOffset, service, region, billed, pulledAt, ...extra })

const ec2Restated = row("src_a", 0, "EC2", "us-east-1", 12, SECOND_PULL)

const SEED: ReadonlyArray<SeedRow> = [
	// Day 0, first pull: later restated, and `Ghost` is dropped by the provider.
	row("src_a", 0, "EC2", "us-east-1", 10, FIRST_PULL),
	row("src_a", 0, "S3", "us-east-1", 4, FIRST_PULL),
	row("src_a", 0, "Ghost", "us-east-1", 99, FIRST_PULL),
	// Day 0, second pull, with one row written twice by an ingest retry.
	ec2Restated,
	ec2Restated,
	row("src_a", 0, "S3", "us-east-1", 4, SECOND_PULL),
	row("src_a", 1, "EC2", "us-east-1", 20, SECOND_PULL, { effective: 18 }),
	row("src_a", 1, "ELB", "eu-central-1", 5, SECOND_PULL),
	row("src_a", 2, "EC2", "us-east-1", 30, SECOND_PULL, { estimated: true }),
	row("src_a", 2, "Route 53", "global", 1, SECOND_PULL, { estimated: true }),
	// The period before: RDS has stopped costing anything since.
	row("src_a", -1, "EC2", "us-east-1", 8, SECOND_PULL),
	row("src_a", -1, "RDS", "us-east-1", 50, SECOND_PULL),
	// A disconnected source keeps its rows.
	row("src_gone", 1, "EC2", "us-east-1", 1000, SECOND_PULL),
	// A day whose only cost vanished on restatement: the second pull wrote the zero marker row.
	row("src_emptied", 0, "Vanished", "us-east-1", 7, FIRST_PULL),
	{ ...row("src_emptied", 0, "", "", 0, SECOND_PULL), marker: true },
	row("src_emptied", -1, "Lambda", "us-east-1", 9, SECOND_PULL),
]

const quote = (value: string): string => `'${Str.replace(/[\\']/g, "\\$&")(value)}'`

const values = (seed: SeedRow): string =>
	seed.marker === true
		? `(${quote(ORG_ID)}, ${quote(seed.source)}, 'aws', '', ${quote(day(seed.day))}, '', '', '', '', '', '', '', 'none', 'billed', '', 0, 0, 0, 0, '', map(), 0, ${quote(seed.pulledAt)})`
		: `(${quote(ORG_ID)}, ${quote(seed.source)}, 'aws', '123456789012', ${quote(day(seed.day))}, ${quote(seed.service)}, '', 'Usage', ${quote(seed.region)}, '', '', '', 'usage', 'billed', 'USD', ${seed.billed}, ${seed.effective ?? seed.billed}, 0, 0, '', map(), ${seed.estimated === true ? 1 : 0}, ${quote(seed.pulledAt)})`

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	const body = await clickhouseExec(normalizeSqlForClickHouseClient(sql), database, {
		default_format: "JSON",
		output_format_json_quote_64bit_integers: "0",
	})
	const parsed = JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }
	return parsed.data ?? []
}

const ACTIVE = { sourceIds: ["src_a"] }

const totals = async (opts: CH.CostReadOpts) => {
	const { sql } = Effect.runSync(CH.compile(CH.costTotalsQuery(opts), params))
	const [first] = await runJson(sql)
	return first
}

const breakdown = async (opts: CH.CostBreakdownOpts) => {
	const { sql } = Effect.runSync(CH.compile(CH.costBreakdownQuery(opts), params))
	return Arr.map(await runJson(sql), (r) => [r.key, r.cost, r.previousCost])
}

const timeseries = async (opts: CH.CostTimeseriesOpts) => {
	const { sql } = Effect.runSync(CH.compile(CH.costTimeseriesQuery(opts), params))
	return Arr.map(await runJson(sql), (r) => [r.date, r.key, r.cost, r.estimated])
}

describe.skipIf(!clickhouseE2eEnabled)("cost_daily reads", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await clickhouseExec(
			`INSERT INTO cost_daily
			 (OrgId, SourceId, Provider, AccountId, Date, CloudService, ServiceCategory, UsageType, Region, ResourceId, ResourceType, ServiceName, ChargeCategory, Basis, Currency, BilledCost, EffectiveCost, ListCost, ConsumedQuantity, ConsumedUnit, Tags, Estimated, IngestedAt)
			 VALUES\n${Arr.join(Arr.map(SEED, values), ",\n")}`,
			database,
		)
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("counts only the newest pull of a day, and a retried row once", async () => {
		// Day 0 is 12 + 4 from the second pull: not 10, not the dropped 99, not 12 twice.
		assert.deepStrictEqual(await totals(ACTIVE), {
			cost: 72,
			previousCost: 58,
			estimatedDays: 1,
			currency: "USD",
			currencies: 1,
		})
	})

	it("sums the effective column when asked for it", async () => {
		assert.strictEqual((await totals({ ...ACTIVE, metric: "effective" }))?.cost, 70)
	})

	it("counts a disconnected source only when the caller names no sources", async () => {
		assert.strictEqual((await totals({}))?.cost, 1072)
	})

	it("reads nothing for an org whose source list is empty", async () => {
		assert.strictEqual((await totals({ sourceIds: [] }))?.cost, 0)
		assert.deepStrictEqual(await breakdown({ sourceIds: [], dimension: "cloud_service" }), [])
	})

	it("narrows by a dimension value, including the value of charges with no region", async () => {
		assert.strictEqual((await totals({ ...ACTIVE, values: { region: ["global"] } }))?.cost, 1)
		assert.strictEqual(
			(await totals({ ...ACTIVE, values: { region: ["global", "eu-central-1"] } }))?.cost,
			6,
		)
	})

	it("returns one row per day, flagged while the provider can still restate it", async () => {
		assert.deepStrictEqual(await timeseries(ACTIVE), [
			[day(0), "", 16, 0],
			[day(1), "", 25, 0],
			[day(2), "", 31, 1],
		])
	})

	it("folds every key outside the named ones into the other series", async () => {
		assert.deepStrictEqual(await timeseries({ ...ACTIVE, dimension: "cloud_service", keys: ["EC2"] }), [
			[day(0), "EC2", 12, 0],
			[day(0), CH.COST_OTHER_KEY, 4, 0],
			[day(1), "EC2", 20, 0],
			[day(1), CH.COST_OTHER_KEY, 5, 0],
			[day(2), "EC2", 30, 1],
			[day(2), CH.COST_OTHER_KEY, 1, 1],
		])
	})

	it("ranks a dimension by cost and keeps a value that only cost money before", async () => {
		assert.deepStrictEqual(await breakdown({ ...ACTIVE, dimension: "cloud_service" }), [
			["EC2", 62, 8],
			["ELB", 5, 0],
			["S3", 4, 0],
			["Route 53", 1, 0],
			["RDS", 0, 50],
		])
	})

	it("reads an emptied day as no cost, in every query", async () => {
		const emptied = { sourceIds: ["src_emptied"] }
		// The marker supersedes `Vanished`, and is itself no row: no '' key, no second currency.
		assert.deepStrictEqual(await breakdown({ ...emptied, dimension: "cloud_service" }), [
			["Lambda", 0, 9],
		])
		assert.deepStrictEqual(await totals(emptied), {
			cost: 0,
			previousCost: 9,
			estimatedDays: 0,
			currency: "USD",
			currencies: 0,
		})
		assert.deepStrictEqual(await timeseries({ ...emptied, dimension: "cloud_service" }), [])
	})

	it("ranks by the size of the move in either direction", async () => {
		assert.deepStrictEqual(
			Arr.map(
				await breakdown({ ...ACTIVE, dimension: "cloud_service", sortBy: "change", limit: 2 }),
				([key]) => key,
			),
			["EC2", "RDS"],
		)
	})

	it("reports the days each source has stored", async () => {
		const { sql } = Effect.runSync(
			CH.compile(CH.costSourceCoverageQuery(ACTIVE), { ...params, startDate: day(-3) }),
		)
		assert.deepStrictEqual(
			Arr.map(await runJson(sql), (r) => [r.sourceId, r.firstDate, r.lastDate]),
			[["src_a", day(-1), day(2)]],
		)
	})
})
