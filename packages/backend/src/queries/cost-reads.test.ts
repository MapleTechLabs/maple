import { afterEach, describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import {
	CostBreakdownRequest,
	CostTimeseriesRequest,
	CostTotalsRequest,
	type TenantContext,
} from "@maple/domain/http"
import {
	DISABLED_ORGANIZATION_FEATURE_FLAGS,
	type OrganizationFeatureFlags,
} from "@maple/domain/organization-feature-flags"
import { OrgId, UserId } from "@maple/primitives"
import { compiledQueryOf, type CompiledQueryInput } from "@maple/query-engine/execution"
import { Database } from "@maple/backend/platform/DatabaseLive"
import type { QueryEngineServiceApi } from "@maple/backend/services/warehouse/QueryEngineService"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/testing/test-pglite"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { makeCostReads } from "./cost-reads"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = "org_cost_reads"
const OTHER_ORG = "org_cost_reads_other"
const SOURCE_A = "0190f2b3-0000-7000-8000-00000000000a"
const SOURCE_B = "0190f2b3-0000-7000-8000-00000000000b"
const SOURCE_C = "0190f2b3-0000-7000-8000-00000000000c"
const SOURCE_D = "0190f2b3-0000-7000-8000-00000000000d"
const SOURCE_E = "0190f2b3-0000-7000-8000-00000000000e"
const SOURCE_F = "0190f2b3-0000-7000-8000-00000000000f"
const FOREIGN_SOURCE = "0190f2b3-0000-7000-8000-0000000000ff"

// History reaches back to 2025-10-01 from here.
const NOW = "2026-11-11T12:00:00Z"

const tenant: TenantContext = {
	orgId: Schema.decodeSync(OrgId)(ORG),
	userId: Schema.decodeSync(UserId)("user_cost_reads"),
	roles: [],
	authMode: "self_hosted",
}

// Three days, entered mid-day on both ends.
const WINDOW = { startTime: "2026-10-01 08:00:00", endTime: "2026-10-03 20:00:00" }
const DAYS = ["2026-10-01", "2026-10-02", "2026-10-03"]

type Rows = ReadonlyArray<Record<string, unknown>>
type QueryKind = "currencies" | "totals" | "breakdown" | "timeseries"

const kindOf = (sql: string): QueryKind =>
	Str.includes("GROUP BY currency ORDER BY")(sql)
		? "currencies"
		: Str.includes("AS currencies")(sql)
			? "totals"
			: Str.includes("AS changeSize")(sql)
				? "breakdown"
				: "timeseries"

/** The statements that read money: every one but the currency lookup each read starts with. */
const moneyReads = (statements: ReadonlyArray<string>) =>
	Arr.filter(statements, (sql) => kindOf(sql) !== "currencies")

/** The currency each statement narrows its rows to, or null for one that reads them all. */
const currencyOf = (sql: string) => /cost_daily\.Currency = '([^']*)'/u.exec(sql)?.[1] ?? null

const USD_THEN_EUR = [
	{ currency: "USD", inWindow: 1, cost: 72, previousCost: 73 },
	{ currency: "EUR", inWindow: 1, cost: 40, previousCost: 0 },
]

/** A warehouse answering each kind of cost query from `rows`, recording every statement it ran. */
const makeWarehouse = (rows: Partial<Record<QueryKind, Rows>>) => {
	const statements: string[] = []
	const decode = (compiled: CompiledQueryInput<unknown>) => {
		const query = compiledQueryOf(compiled)
		const statement = Str.replace(/\s+/g, " ")(query.sql)
		statements.push(statement)
		return query.decodeRows(rows[kindOf(statement)] ?? []).pipe(Effect.orDie)
	}
	const warehouse = makeWarehouseServiceStub({
		// SAFETY: these reads hand the stub a plain compiled query, never a capability compile.
		compiledQuery: ((_tenant: unknown, compiled: CompiledQueryInput<unknown>) =>
			decode(compiled)) as never,
		// SAFETY: as above.
		compiledQueryFirst: ((_tenant: unknown, compiled: CompiledQueryInput<unknown>) =>
			decode(compiled).pipe(Effect.map((decoded) => Option.fromNullishOr(decoded[0])))) as never,
	})
	return { warehouse, statements }
}

/** The query engine as the reads see it: `cachedDirect` runs the compute. */
const queryEngine: QueryEngineServiceApi = {
	execute: () => Effect.die("execute is not used by these reads"),
	evaluate: () => Effect.die("evaluate is not used by these reads"),
	evaluateSeries: () => Effect.die("evaluateSeries is not used by these reads"),
	cachedDirect: (_tenant, _route, _payload, effect) => effect,
}

interface SourceFixture {
	readonly id: string
	readonly orgId?: string
	readonly watermarkDate?: string
	readonly backfillDate?: string
	readonly lastSyncedAt?: string
	readonly lastError?: string
	readonly lastErrorReason?: string
	readonly requestsMonth?: string
	readonly requestsCount?: number
	readonly enabled?: boolean
}

/** Rows are created a second apart in the order given, which is the order the reads list them. */
const insertSources = (testDb: TestDb, sources: ReadonlyArray<SourceFixture>) =>
	Effect.forEach(sources, (source, index) =>
		Effect.promise(() =>
			executeSql(
				testDb,
				`INSERT INTO cost_sources (id, org_id, provider, connection_ref, account_id, watermark_date,
				   backfill_date, last_synced_at, last_error, last_error_reason, requests_month,
				   requests_count, created_at, updated_at, enabled)
				 VALUES ($1, $2, 'aws', $1, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10,
				   '2026-11-01T00:00:00Z'::timestamptz + make_interval(secs => $11), now(), $12)`,
				[
					source.id,
					source.orgId ?? ORG,
					`00000000000${index}`,
					source.watermarkDate ?? null,
					source.backfillDate ?? null,
					source.lastSyncedAt ?? null,
					source.lastError ?? null,
					source.lastErrorReason ?? null,
					source.requestsMonth ?? null,
					source.requestsCount ?? 0,
					index,
					source.enabled ?? true,
				],
			),
		),
	)

const withFlags = (flags: Partial<OrganizationFeatureFlags>) => ({
	flags: () => Effect.succeed({ ...DISABLED_ORGANIZATION_FEATURE_FLAGS, ...flags }),
})

/** The reads over `testDb` and a fake warehouse, for an org in the `cloudCost` rollout unless told otherwise. */
const makeHarness = (
	testDb: TestDb,
	rows: Partial<Record<QueryKind, Rows>> = {},
	flags: Partial<OrganizationFeatureFlags> = { cloudCost: true },
) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(Date.parse(NOW))
		const { warehouse, statements } = makeWarehouse(rows)
		const database = yield* Database
		const reads = makeCostReads({ warehouse, queryEngine, database, featureFlags: withFlags(flags) })
		return { reads, statements }
	})

const timeseriesRow = (date: string, key: string, cost: number, estimated = 0) => ({
	date,
	key,
	other: 0,
	cost,
	estimated,
})

/** A day's row of every value outside the kept keys, as the query folds them. */
const foldedRow = (date: string, cost: number, estimated = 0) => ({
	...timeseriesRow(date, "__other__", cost, estimated),
	other: 1,
})

describe("makeCostReads", () => {
	it.effect("answers the empty shape without asking the warehouse for an org with no source", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertSources(testDb, [{ id: FOREIGN_SOURCE, orgId: OTHER_ORG }])
			const { reads, statements } = yield* makeHarness(testDb)
			expect(yield* reads.totals(tenant, new CostTotalsRequest(WINDOW))).toEqual({
				cost: 0,
				previousCost: 0,
				estimatedDays: 0,
				currency: "",
				currencies: [],
				days: 3,
			})
			expect(
				yield* reads.timeseries(tenant, new CostTimeseriesRequest({ ...WINDOW, groupBy: "region" })),
			).toEqual({
				currency: "",
				days: DAYS,
				series: [],
				estimatedFrom: null,
			})
			expect(
				yield* reads.breakdown(
					tenant,
					new CostBreakdownRequest({ ...WINDOW, groupBy: "region", currency: "EUR" }),
				),
			).toEqual({ currency: "", rows: [] })
			expect(yield* reads.sources(tenant)).toEqual({ sources: [] })
			expect(statements).toEqual([])
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("narrows every warehouse read to the org's own sources", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertSources(testDb, [
				{ id: SOURCE_A },
				{ id: SOURCE_B },
				{ id: FOREIGN_SOURCE, orgId: OTHER_ORG },
			])
			const { reads, statements } = yield* makeHarness(testDb, {
				breakdown: [{ key: "eu-central-1", cost: 4, previousCost: 1, changeSize: 3 }],
			})
			yield* reads.totals(tenant, new CostTotalsRequest(WINDOW))
			yield* reads.timeseries(tenant, new CostTimeseriesRequest(WINDOW))
			yield* reads.timeseries(tenant, new CostTimeseriesRequest({ ...WINDOW, groupBy: "region" }))
			yield* reads.breakdown(tenant, new CostBreakdownRequest({ ...WINDOW, groupBy: "region" }))
			// Totals, the plain series, the top keys and their series, the breakdown: each read
			// starts by asking which currencies there are.
			expect(Arr.map(statements, kindOf)).toEqual([
				"currencies",
				"totals",
				"currencies",
				"timeseries",
				"currencies",
				"breakdown",
				"timeseries",
				"currencies",
				"breakdown",
			])
			expect(
				Arr.filter(
					statements,
					(sql) => !Str.includes(`cost_daily.SourceId IN ('${SOURCE_A}', '${SOURCE_B}')`)(sql),
				),
			).toEqual([])
			expect(Arr.filter(statements, Str.includes(FOREIGN_SOURCE))).toEqual([])
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("reports the window's totals in its largest currency, with its length", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertSources(testDb, [{ id: SOURCE_A }])
			const { reads, statements } = yield* makeHarness(testDb, {
				currencies: USD_THEN_EUR,
				totals: [{ cost: 120.5, previousCost: 80, estimatedDays: 2, currency: "USD", currencies: 1 }],
			})
			expect(
				yield* reads.totals(
					tenant,
					new CostTotalsRequest({
						...WINDOW,
						metric: "effective",
						filters: { region: ["eu-central-1"] },
					}),
				),
			).toEqual({
				cost: 120.5,
				previousCost: 80,
				estimatedDays: 2,
				currency: "USD",
				currencies: ["USD", "EUR"],
				days: 3,
			})
			// The currencies are looked up over the same rows the totals then sum one currency of.
			expect(Arr.map(statements, kindOf)).toEqual(["currencies", "totals"])
			expect(Arr.map(statements, currencyOf)).toEqual([null, "USD"])
			expect(
				Arr.filter(
					statements,
					(sql) =>
						Str.includes("max(cost_daily.EffectiveCost)")(sql) &&
						Str.includes("cost_daily.Region IN ('eu-central-1')")(sql) &&
						// The three days of the window and the three before them.
						Str.includes("cost_daily.Date >= '2026-09-28 00:00:00'")(sql) &&
						Str.includes("cost_daily.Date <= '2026-10-03 00:00:00'")(sql),
				),
			).toHaveLength(2)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("resolves the currency once per read and passes it to every query", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertSources(testDb, [{ id: SOURCE_A }])
			const { reads, statements } = yield* makeHarness(testDb, {
				currencies: USD_THEN_EUR,
				breakdown: [{ key: "eu-central-1", cost: 4, previousCost: 1, changeSize: 3 }],
			})
			const split = new CostTimeseriesRequest({ ...WINDOW, groupBy: "region" })
			const shown = [
				(yield* reads.totals(tenant, new CostTotalsRequest(WINDOW))).currency,
				(yield* reads.timeseries(tenant, new CostTimeseriesRequest(WINDOW))).currency,
				(yield* reads.timeseries(tenant, split)).currency,
				(yield* reads.breakdown(tenant, new CostBreakdownRequest({ ...WINDOW, groupBy: "region" })))
					.currency,
			]
			// The largest in the window, though nothing asked for it.
			expect(shown).toEqual(["USD", "USD", "USD", "USD"])
			// One lookup per read, over every currency; the split series' two queries share its answer.
			expect(Arr.map(statements, (sql) => [kindOf(sql), currencyOf(sql)])).toEqual([
				["currencies", null],
				["totals", "USD"],
				["currencies", null],
				["timeseries", "USD"],
				["currencies", null],
				["breakdown", "USD"],
				["timeseries", "USD"],
				["currencies", null],
				["breakdown", "USD"],
			])
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("reads the currency the request names, and lists it first", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertSources(testDb, [{ id: SOURCE_A }])
			const { reads, statements } = yield* makeHarness(testDb, {
				currencies: USD_THEN_EUR,
				totals: [{ cost: 40, previousCost: 0, estimatedDays: 0, currency: "EUR", currencies: 1 }],
				breakdown: [{ key: "AmazonEC2", cost: 40, previousCost: 0, changeSize: 40 }],
			})
			const eur = { ...WINDOW, currency: "EUR" }
			expect(yield* reads.totals(tenant, new CostTotalsRequest(eur))).toMatchObject({
				cost: 40,
				currency: "EUR",
				currencies: ["EUR", "USD"],
			})
			const series = yield* reads.timeseries(
				tenant,
				new CostTimeseriesRequest({ ...eur, groupBy: "cloud_service" }),
			)
			const rows = yield* reads.breakdown(
				tenant,
				new CostBreakdownRequest({ ...eur, groupBy: "cloud_service" }),
			)
			expect([series.currency, rows.currency]).toEqual(["EUR", "EUR"])
			// Totals, the top keys and their series, the breakdown: none reads the larger USD.
			expect(Arr.map(moneyReads(statements), currencyOf)).toEqual(["EUR", "EUR", "EUR", "EUR"])
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("reads zeros in a currency nothing is billed in, and still lists what is", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertSources(testDb, [{ id: SOURCE_A }])
			const { reads, statements } = yield* makeHarness(testDb, {
				currencies: USD_THEN_EUR,
				totals: [{ cost: 0, previousCost: 0, estimatedDays: 0, currency: "", currencies: 0 }],
			})
			expect(
				yield* reads.totals(tenant, new CostTotalsRequest({ ...WINDOW, currency: "GBP" })),
			).toEqual({
				cost: 0,
				previousCost: 0,
				estimatedDays: 0,
				currency: "GBP",
				currencies: ["USD", "EUR"],
				days: 3,
			})
			expect(Arr.map(moneyReads(statements), currencyOf)).toEqual(["GBP"])
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("names no currency for sources that have billed nothing, and still sums none together", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertSources(testDb, [{ id: SOURCE_A }])
			const { reads, statements } = yield* makeHarness(testDb, {
				totals: [{ cost: 0, previousCost: 0, estimatedDays: 0, currency: "", currencies: 0 }],
			})
			expect(yield* reads.totals(tenant, new CostTotalsRequest(WINDOW))).toMatchObject({
				cost: 0,
				currency: "",
				currencies: [],
			})
			// Rows that land between the two queries are not added up across their currencies.
			expect(Arr.map(moneyReads(statements), currencyOf)).toEqual([""])
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("draws one zero-filled series per top key, the rest folded into a last one", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertSources(testDb, [{ id: SOURCE_A }])
			const { reads, statements } = yield* makeHarness(testDb, {
				currencies: USD_THEN_EUR,
				breakdown: [
					{ key: "AmazonS3", cost: 40, previousCost: 0, changeSize: 40 },
					{ key: "AmazonEC2", cost: 15, previousCost: 30, changeSize: 15 },
				],
				timeseries: [
					timeseriesRow("2026-10-01", "AmazonEC2", 10),
					foldedRow("2026-10-01", 60),
					timeseriesRow("2026-10-02", "AmazonS3", 40, 1),
					foldedRow("2026-10-02", 40, 1),
					timeseriesRow("2026-10-03", "AmazonEC2", 5, 1),
				],
			})
			const result = yield* reads.timeseries(
				tenant,
				new CostTimeseriesRequest({ ...WINDOW, groupBy: "cloud_service", limit: 2 }),
			)
			expect(result).toEqual({
				currency: "USD",
				days: DAYS,
				series: [
					{ key: "AmazonS3", other: false, total: 40, points: [0, 40, 0] },
					{ key: "AmazonEC2", other: false, total: 15, points: [10, 0, 5] },
					// The largest of all, and still last.
					{ key: "__other__", other: true, total: 100, points: [60, 40, 0] },
				],
				estimatedFrom: "2026-10-02",
			})
			const [topKeys, series] = moneyReads(statements)
			expect(topKeys).toContain("ORDER BY cost DESC, key ASC LIMIT 2")
			expect(series).toContain("IN ('AmazonS3', 'AmazonEC2')")
			// The series cover the window alone, not the period the top keys are compared against.
			expect(series).toContain("cost_daily.Date >= '2026-10-01 00:00:00'")
			expect(series).not.toContain("2026-09-28")
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("leaves the folded series out when it is all zero, and names eight keys by default", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertSources(testDb, [{ id: SOURCE_A }])
			const { reads, statements } = yield* makeHarness(testDb, {
				breakdown: [{ key: "eu-central-1", cost: 7, previousCost: 0, changeSize: 7 }],
				timeseries: [timeseriesRow("2026-10-02", "eu-central-1", 7), foldedRow("2026-10-02", 0)],
			})
			const result = yield* reads.timeseries(
				tenant,
				new CostTimeseriesRequest({ ...WINDOW, groupBy: "region" }),
			)
			expect(result.series).toEqual([
				{ key: "eu-central-1", other: false, total: 7, points: [0, 7, 0] },
			])
			expect(result.estimatedFrom).toBeNull()
			expect(moneyReads(statements)[0]).toContain("LIMIT 8")
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("keeps a value named like the folded key as a series of its own", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertSources(testDb, [{ id: SOURCE_A }])
			const { reads } = yield* makeHarness(testDb, {
				currencies: USD_THEN_EUR,
				breakdown: [{ key: "__other__", cost: 9, previousCost: 0, changeSize: 9 }],
				timeseries: [
					timeseriesRow("2026-10-01", "__other__", 7),
					foldedRow("2026-10-01", 30),
					timeseriesRow("2026-10-03", "__other__", 2),
					foldedRow("2026-10-03", 5),
				],
			})
			const result = yield* reads.timeseries(
				tenant,
				new CostTimeseriesRequest({ ...WINDOW, groupBy: "cloud_service", limit: 1 }),
			)
			// The same key twice: the service that is called so, then everything that was folded.
			expect(result.series).toEqual([
				{ key: "__other__", other: false, total: 9, points: [7, 0, 2] },
				{ key: "__other__", other: true, total: 35, points: [30, 0, 5] },
			])
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("reads no series when the split finds no key", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertSources(testDb, [{ id: SOURCE_A }])
			const { reads, statements } = yield* makeHarness(testDb)
			expect(
				yield* reads.timeseries(tenant, new CostTimeseriesRequest({ ...WINDOW, groupBy: "service" })),
			).toEqual({
				currency: "",
				days: DAYS,
				series: [],
				estimatedFrom: null,
			})
			expect(Arr.map(statements, kindOf)).toEqual(["currencies", "breakdown"])
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("draws the whole cost as one series when it is not split", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertSources(testDb, [{ id: SOURCE_A }])
			const some = yield* makeHarness(testDb, {
				currencies: [{ currency: "EUR", inWindow: 1, cost: 15, previousCost: 0 }],
				timeseries: [timeseriesRow("2026-10-01", "", 12), timeseriesRow("2026-10-03", "", 3, 1)],
			})
			expect(yield* some.reads.timeseries(tenant, new CostTimeseriesRequest(WINDOW))).toEqual({
				currency: "EUR",
				days: DAYS,
				series: [{ key: "", other: false, total: 15, points: [12, 0, 3] }],
				estimatedFrom: "2026-10-03",
			})
			expect(Arr.map(some.statements, kindOf)).toEqual(["currencies", "timeseries"])

			// Sources connected, nothing billed yet: a flat line, not a missing one.
			const quiet = yield* makeHarness(testDb)
			expect((yield* quiet.reads.timeseries(tenant, new CostTimeseriesRequest(WINDOW))).series).toEqual(
				[{ key: "", other: false, total: 0, points: [0, 0, 0] }],
			)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("lists a dimension's values with the period before, sorted and cut as asked", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertSources(testDb, [{ id: SOURCE_A }])
			const { reads, statements } = yield* makeHarness(testDb, {
				currencies: USD_THEN_EUR,
				breakdown: [
					{ key: "AmazonRDS", cost: 0, previousCost: 90, changeSize: 90 },
					{ key: "AmazonEC2", cost: 50, previousCost: 20, changeSize: 30 },
				],
			})
			expect(
				yield* reads.breakdown(
					tenant,
					new CostBreakdownRequest({
						...WINDOW,
						groupBy: "cloud_service",
						sortBy: "change",
						limit: 25,
					}),
				),
			).toEqual({
				currency: "USD",
				rows: [
					{ key: "AmazonRDS", cost: 0, previousCost: 90 },
					{ key: "AmazonEC2", cost: 50, previousCost: 20 },
				],
			})
			expect(moneyReads(statements)[0]).toContain("ORDER BY changeSize DESC, key ASC LIMIT 25")
			yield* reads.breakdown(tenant, new CostBreakdownRequest({ ...WINDOW, groupBy: "cloud_service" }))
			expect(moneyReads(statements)[1]).toContain("ORDER BY cost DESC, key ASC LIMIT 50")
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect(
		"derives each source's status from its sync state, and restarts the request count monthly",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* insertSources(testDb, [
					{ id: SOURCE_A },
					{
						id: SOURCE_B,
						watermarkDate: "2026-11-11",
						backfillDate: "2026-09-01",
						lastSyncedAt: "2026-11-11T11:00:00Z",
						requestsMonth: "2026-11",
						requestsCount: 12,
					},
					{
						id: SOURCE_C,
						watermarkDate: "2026-11-11",
						backfillDate: "2025-10-01",
						lastSyncedAt: "2026-11-11T11:00:00Z",
						requestsMonth: "2026-10",
						requestsCount: 340,
					},
					{
						id: SOURCE_D,
						watermarkDate: "2026-11-09",
						backfillDate: "2025-10-01",
						lastError: "The role may not read cost.",
						lastErrorReason: "auth",
						requestsMonth: "2026-11",
						requestsCount: 3,
					},
					// Paused with an old error: it reads as paused, and its history is still listed.
					{
						id: SOURCE_E,
						enabled: false,
						watermarkDate: "2026-11-02",
						backfillDate: "2025-10-01",
						lastError: "The role may not read cost.",
						lastErrorReason: "auth",
					},
					// Held by the month's request budget: nothing failed, so it is not an error.
					{
						id: SOURCE_F,
						watermarkDate: "2026-11-10",
						backfillDate: "2026-03-01",
						lastError: "This month's provider request budget is spent; pulls resume next month.",
						lastErrorReason: "budget",
						requestsMonth: "2026-11",
						requestsCount: 1500,
					},
					{ id: FOREIGN_SOURCE, orgId: OTHER_ORG },
				])
				const { reads, statements } = yield* makeHarness(testDb)
				const { sources } = yield* reads.sources(tenant)
				expect(
					Arr.map(sources, (source) => ({
						id: source.id,
						status: source.status,
						historyComplete: source.historyComplete,
						requestsThisMonth: source.requestsThisMonth,
					})),
				).toEqual([
					{ id: SOURCE_A, status: "pending", historyComplete: false, requestsThisMonth: 0 },
					{ id: SOURCE_B, status: "syncing", historyComplete: false, requestsThisMonth: 12 },
					// Last month's count is not this month's.
					{ id: SOURCE_C, status: "ok", historyComplete: true, requestsThisMonth: 0 },
					{ id: SOURCE_D, status: "error", historyComplete: true, requestsThisMonth: 3 },
					{ id: SOURCE_E, status: "paused", historyComplete: true, requestsThisMonth: 0 },
					{ id: SOURCE_F, status: "held", historyComplete: false, requestsThisMonth: 1500 },
				])
				expect(sources[1]).toMatchObject({
					provider: "aws",
					accountId: "000000000001",
					watermarkDate: "2026-11-11",
					backfillDate: "2026-09-01",
					lastSyncedAt: Date.parse("2026-11-11T11:00:00Z"),
					lastError: null,
					lastErrorReason: null,
				})
				expect(sources[3]).toMatchObject({
					lastSyncedAt: null,
					lastError: "The role may not read cost.",
					lastErrorReason: "auth",
				})
				expect(statements).toEqual([])
			}).pipe(Effect.provide(testDb.layer))
		},
	)

	it.effect("names a Vercel source by its team's slug, beside the team id its rows carry", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertSources(testDb, [{ id: SOURCE_A }])
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`WITH source AS (
					   INSERT INTO sources (id, org_id, name, platform, kind, created_at, updated_at)
					   VALUES (gen_random_uuid(), $1, 'Acme', 'vercel', 'integration', now(), now()) RETURNING id
					 ), connection AS (
					   INSERT INTO vercel_connections
					     (id, org_id, source_id, team_id, team_slug, team_name, token_ciphertext, token_iv, token_tag,
					      connected_by_user_id, project_scope, created_at, updated_at)
					   SELECT 'conn_vercel', $1, id, 'team_1', 'acme-labs', 'Acme', 'sealed', 'iv', 'tag', 'user_a', 'all', now(), now()
					   FROM source RETURNING id
					 )
					 INSERT INTO cost_sources (id, org_id, provider, connection_ref, account_id, created_at, updated_at)
					 SELECT $2, $1, 'vercel', id, 'team_1', now(), now() FROM connection`,
					[ORG, SOURCE_B],
				),
			)
			const { reads } = yield* makeHarness(testDb)
			const { sources } = yield* reads.sources(tenant)
			expect(
				Arr.map(sources, (source) => [source.provider, source.accountId, source.accountName]),
			).toEqual([
				// An AWS account is known by its id: it carries no other name.
				["aws", "000000000000", undefined],
				["vercel", "team_1", "acme-labs"],
			])
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("refuses a window wider than a cost read takes, before asking the warehouse", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertSources(testDb, [{ id: SOURCE_A }])
			const { reads, statements } = yield* makeHarness(testDb)
			const years = { startTime: "2020-01-01 00:00:00", endTime: "2026-11-11 00:00:00" }
			const refusals = yield* Effect.all([
				Effect.flip(reads.totals(tenant, new CostTotalsRequest(years))),
				Effect.flip(reads.timeseries(tenant, new CostTimeseriesRequest(years))),
				Effect.flip(
					reads.breakdown(tenant, new CostBreakdownRequest({ ...years, groupBy: "region" })),
				),
			])
			expect(Arr.map(refusals, (error) => error._tag)).toEqual(
				Arr.replicate("@maple/http/errors/QueryEngineValidationError", 3),
			)
			expect(statements).toEqual([])
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("refuses a window in a year no read takes, before asking the warehouse", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			// No source either: the days of the window are listed without any warehouse read.
			const { reads, statements } = yield* makeHarness(testDb)
			const farFuture = { startTime: "9999-12-31 00:00:00", endTime: "9999-12-31 00:00:00" }
			const refusals = yield* Effect.all([
				Schema.decodeEffect(CostTotalsRequest)(farFuture).pipe(
					Effect.flatMap((request) => reads.totals(tenant, request)),
					Effect.flip,
				),
				Schema.decodeEffect(CostTimeseriesRequest)(farFuture).pipe(
					Effect.flatMap((request) => reads.timeseries(tenant, request)),
					Effect.flip,
				),
				Schema.decodeEffect(CostBreakdownRequest)({ ...farFuture, groupBy: "region" }).pipe(
					Effect.flatMap((request) => reads.breakdown(tenant, request)),
					Effect.flip,
				),
			])
			expect(Arr.map(refusals, (error) => error._tag)).toEqual(Arr.replicate("SchemaError", 3))
			expect(statements).toEqual([])

			// A bound that got past the boundary all the same lists its one day, and stops there.
			const unchecked = new CostTimeseriesRequest(farFuture, { disableChecks: true })
			expect((yield* reads.timeseries(tenant, unchecked)).days).toEqual(["9999-12-31"])
			// The last year a read takes, across a leap day.
			const leap = { startTime: "2096-02-28 12:00:00", endTime: "2096-03-01 12:00:00" }
			expect((yield* reads.timeseries(tenant, new CostTimeseriesRequest(leap))).days).toEqual([
				"2096-02-28",
				"2096-02-29",
				"2096-03-01",
			])
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("refuses a window that starts after it ends, before asking the warehouse", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertSources(testDb, [{ id: SOURCE_A }])
			const { reads, statements } = yield* makeHarness(testDb)
			// Floored to days it would read as October 3rd alone.
			const reversed = { startTime: "2026-10-03 20:00:00", endTime: "2026-10-01 08:00:00" }
			// The same second: only the fraction, of another length, puts the start later.
			const reversedWithinASecond = {
				startTime: "2026-10-03 20:00:00.5",
				endTime: "2026-10-03 20:00:00.25",
			}
			const refusals = yield* Effect.all([
				Effect.flip(reads.totals(tenant, new CostTotalsRequest(reversed))),
				Effect.flip(reads.timeseries(tenant, new CostTimeseriesRequest(reversed))),
				Effect.flip(
					reads.breakdown(tenant, new CostBreakdownRequest({ ...reversed, groupBy: "region" })),
				),
				Effect.flip(reads.totals(tenant, new CostTotalsRequest(reversedWithinASecond))),
			])
			expect(Arr.map(refusals, (error) => error._tag)).toEqual(
				Arr.replicate("@maple/http/errors/QueryEngineValidationError", 4),
			)
			expect(statements).toEqual([])

			// One day, entered as a span inside it or as a single instant.
			const sameDay = { startTime: "2026-10-03 08:00:00", endTime: "2026-10-03 20:00:00.250" }
			const instant = { startTime: "2026-10-03 08:00:00", endTime: "2026-10-03 08:00:00.000" }
			expect((yield* reads.totals(tenant, new CostTotalsRequest(sameDay))).days).toBe(1)
			expect((yield* reads.timeseries(tenant, new CostTimeseriesRequest(instant))).days).toEqual([
				"2026-10-03",
			])
			expect(
				(yield* reads.breakdown(tenant, new CostBreakdownRequest({ ...sameDay, groupBy: "region" })))
					.rows,
			).toEqual([])
			expect(moneyReads(statements)).toHaveLength(3)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("refuses every read for an org outside the cloudCost rollout", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertSources(testDb, [{ id: SOURCE_A }])
			const { reads, statements } = yield* makeHarness(testDb, {}, { statusPages: true })
			const refusals = yield* Effect.all([
				Effect.flip(reads.totals(tenant, new CostTotalsRequest(WINDOW))),
				Effect.flip(reads.timeseries(tenant, new CostTimeseriesRequest(WINDOW))),
				Effect.flip(
					reads.breakdown(tenant, new CostBreakdownRequest({ ...WINDOW, groupBy: "region" })),
				),
				Effect.flip(reads.sources(tenant)),
			])
			expect(Arr.map(refusals, (error) => error._tag)).toEqual(
				Arr.replicate("@maple/http/errors/CloudCostDisabledError", 4),
			)
			expect(statements).toEqual([])
		}).pipe(Effect.provide(testDb.layer))
	})
})
