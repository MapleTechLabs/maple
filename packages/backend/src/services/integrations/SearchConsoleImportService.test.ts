import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	ConfigProvider,
	DateTime,
	Effect,
	Duration,
	Fiber,
	Layer,
	Option,
	Schema,
	Array as Arr,
	String as Str,
} from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { OrgId, UserId, WarehouseUpstreamError } from "@maple/domain/http"
import { SearchConsoleSiteUrl } from "@maple/primitives"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import * as VendorFake from "@maple/backend/testing/vendor-fake"
import { GoogleOAuthService } from "@maple/backend/services/auth/GoogleOAuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { addDays, daysBetween, planImport } from "./google-search-console/import-plan"
import { SearchConsoleImportService } from "./SearchConsoleImportService"
import { SearchConsoleService } from "./SearchConsoleService"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

// 04:00 in Pacific time, so Google's day is 2026-11-08 too.
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-08T12:00:00Z"))
const SITE = "sc-domain:acme.dev"
const SCOPE = "openid email https://www.googleapis.com/auth/webmasters.readonly"
const ID_TOKEN = `h.${Buffer.from(JSON.stringify({ sub: "g-1", email: "owner@acme.dev" })).toString("base64url")}.s`

const SearchAnalyticsBody = Schema.Struct({
	startDate: Schema.String,
	endDate: Schema.String,
	dimensions: Schema.Array(Schema.String),
	startRow: Schema.Number,
	rowLimit: Schema.Number,
	dataState: Schema.String,
})
type SearchAnalyticsBody = typeof SearchAnalyticsBody.Type
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(SearchAnalyticsBody))

/** A `search_console_daily` row as the importer hands it to `ingest`. */
const WrittenRow = Schema.Struct({
	OrgId: Schema.String,
	SiteUrl: Schema.String,
	Grain: Schema.String,
	SearchType: Schema.String,
	Date: Schema.String,
	Page: Schema.String,
	Query: Schema.String,
	Country: Schema.String,
	Device: Schema.String,
	Clicks: Schema.Number,
	Impressions: Schema.Number,
	PositionSum: Schema.Number,
	IngestedAt: Schema.String,
})
const decodeWrittenRows = Schema.decodeUnknownSync(Schema.Array(WrittenRow))

const daysOf = (start: string, end: string) =>
	Arr.map(Arr.range(0, daysBetween(start, end) - 1), (offset) => addDays(start, offset))

/** The day `queryRowsTotal` applies to; every other day holds one row per grain. */
const PAGED_DAY = "2026-11-08"

interface FakeGoogleOptions {
	/** Rows the query grain holds on `pagedDay`, served page by page; one when unset. */
	readonly queryRowsTotal?: number
	/** The day holding `queryRowsTotal` query rows, `PAGED_DAY` when unset. */
	readonly pagedDay?: string
	/** A query-grain page (day and start row) that answers 500. */
	readonly failPage?: { readonly day: string; readonly startRow: number }
	/** Days whose Search Analytics requests answer 500, at every grain. */
	readonly failDays?: ReadonlyArray<string>
	/** Status every Search Analytics request answers with. */
	readonly failStatus?: number
	/** Properties whose Search Analytics requests answer 500; the rest succeed. */
	readonly failingSites?: ReadonlyArray<string>
	/** Search Analytics requests never answer until aborted. */
	readonly hang?: boolean
	/** The first Search Analytics request for each of these days never answers; later ones do. */
	readonly hangDaysOnce?: ReadonlyArray<string>
	/** The `ingest` call (1-based) that fails once with a 503, then succeeds when sent again. */
	readonly failIngestCallOnce?: number
}

const siteOfUrl = (url: string) =>
	decodeURIComponent(Str.split("/searchAnalytics/")(Str.split("/sites/")(url)[1] ?? "")[0] ?? "")

const keyFor = (dimension: string, day: string, query: string) =>
	dimension === "date"
		? day
		: dimension === "country"
			? "usa"
			: dimension === "device"
				? "DESKTOP"
				: dimension === "page"
					? "https://acme.dev/pricing"
					: query

/** Google's token and Search Console endpoints; Search Analytics answers one row per day per grain. */
const fakeGoogle = (options: FakeGoogleOptions) => {
	const queries: SearchAnalyticsBody[] = []
	const querySites: string[] = []
	const hangWaiters: Array<() => void> = []
	const hungDays = new Set<string>()
	/** Resolves once the next hanging Search Analytics request is in flight. */
	const nextHang = () => new Promise<void>((resolve) => hangWaiters.push(resolve))
	const respond = async (request: VendorFake.VendorFakeRequest): Promise<Response> => {
		const url = request.url.href
		if (url === "https://oauth2.googleapis.com/token") {
			return VendorFake.json({
				access_token: "g-access",
				refresh_token: "g-refresh",
				expires_in: 3599,
				scope: SCOPE,
				id_token: ID_TOKEN,
			})
		}
		if (url === "https://www.googleapis.com/webmasters/v3/sites") {
			return VendorFake.json({ siteEntry: [{ siteUrl: SITE, permissionLevel: "siteOwner" }] })
		}
		if (Str.endsWith("/searchAnalytics/query")(url)) {
			const body = decodeBody(request.body)
			queries.push(body)
			querySites.push(siteOfUrl(url))
			const hangOnce =
				options.hangDaysOnce?.includes(body.startDate) === true && !hungDays.has(body.startDate)
			if (hangOnce) hungDays.add(body.startDate)
			if (options.hang === true || hangOnce) {
				Arr.forEach(hangWaiters.splice(0), (resolve) => resolve())
				return VendorFake.hang(request)
			}
			if (options.failStatus !== undefined) return VendorFake.json({}, options.failStatus)
			if (options.failingSites?.includes(siteOfUrl(url))) return VendorFake.json({}, 500)
			if (options.failDays?.includes(body.startDate)) return VendorFake.json({}, 500)
			const isQueryGrain = body.dimensions.includes("query")
			if (
				isQueryGrain &&
				options.failPage?.day === body.startDate &&
				options.failPage.startRow === body.startRow
			)
				return VendorFake.json({}, 500)
			const keys = (day: string, query: string) =>
				Arr.map(body.dimensions, (dimension) => keyFor(dimension, day, query))
			const total =
				isQueryGrain && body.startDate === (options.pagedDay ?? PAGED_DAY)
					? options.queryRowsTotal
					: undefined
			if (total === undefined) {
				return VendorFake.json({
					rows: Arr.map(daysOf(body.startDate, body.endDate), (day) => ({
						keys: keys(day, "maple observability"),
						clicks: 3,
						impressions: 40,
						ctr: 0.075,
						position: 2.5,
					})),
				})
			}
			const end = Math.min(total, body.startRow + body.rowLimit)
			return VendorFake.json({
				rows:
					body.startRow >= end
						? []
						: Arr.map(Arr.range(body.startRow, end - 1), (index) => ({
								keys: keys(body.endDate, `query ${index}`),
								clicks: 1,
								impressions: 10,
								ctr: 0.1,
								position: 4,
							})),
			})
		}
		return VendorFake.json({}, 404)
	}
	const fake = VendorFake.make({ routes: [{ respond }] })
	return { fake, queries, querySites, nextHang }
}

const config = {
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	MAPLE_INGEST_PUBLIC_URL: "https://ingest.example.com",
	GOOGLE_SEARCH_CONSOLE_CLIENT_ID: "g-client-id",
	GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET: "g-client-secret",
}

const orgA = Schema.decodeSync(OrgId)("org_a")
const userA = Schema.decodeSync(UserId)("user_a")

interface SiteState {
	readonly watermark: string | null
	readonly backfill: string | null
	readonly synced: string | null
	readonly lease: string | null
	readonly error: string | null
}

const harness = (options: FakeGoogleOptions = {}) => {
	const testDb = createTestDb(trackedDbs)
	const google = fakeGoogle(options)
	const writes: Array<{
		readonly datasource: string
		readonly rows: ReadonlyArray<typeof WrittenRow.Type>
	}> = []
	let ingestCalls = 0
	const warehouse = Layer.succeed(
		WarehouseQueryService,
		makeWarehouseServiceStub({
			ingest: (_tenant, datasource, rows) =>
				Effect.suspend(() => {
					ingestCalls += 1
					if (ingestCalls === options.failIngestCallOnce) {
						return Effect.fail(
							new WarehouseUpstreamError({
								message: "503",
								pipeName: "ingest",
								upstreamStatus: 503,
							}),
						)
					}
					writes.push({ datasource, rows: decodeWrittenRows(rows) })
					return Effect.void
				}),
		}),
	)
	const layer = Layer.mergeAll(
		Layer.effect(SearchConsoleImportService, SearchConsoleImportService.make),
		SearchConsoleService.layer,
	).pipe(
		Layer.provideMerge(GoogleOAuthService.layer),
		Layer.provide(Layer.mergeAll(warehouse, FetchHttpClient.layer)),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
		Layer.provideMerge(google.fake.layer),
	)
	const sql = (statement: string, params: unknown[] = []) =>
		Effect.promise(() => executeSql(testDb, statement, params))
	const siteState = Effect.promise(() =>
		queryFirstRow<SiteState>(
			testDb,
			`SELECT watermark_date AS watermark, backfill_date AS backfill,
			        (extract(epoch from last_synced_at) * 1000)::bigint::text AS synced,
			        (extract(epoch from lease_until) * 1000)::bigint::text AS lease, last_error AS error
			   FROM search_console_sites WHERE org_id = $1 AND site_url = $2`,
			["org_a", SITE],
		),
	)
	const nextAttemptOf = (siteUrl: string) =>
		Effect.promise(() =>
			queryFirstRow<{ next: string | null }>(
				testDb,
				`SELECT (extract(epoch from next_attempt_at) * 1000)::bigint::text AS next
				   FROM search_console_sites WHERE org_id = $1 AND site_url = $2`,
				["org_a", siteUrl],
			),
		).pipe(Effect.map((row) => row?.next ?? null))
	const backoffOf = Effect.promise(() =>
		queryFirstRow<{ failures: number; next: string | null }>(
			testDb,
			`SELECT consecutive_failures AS failures,
			        (extract(epoch from next_attempt_at) * 1000)::bigint::text AS next
			   FROM search_console_sites WHERE org_id = $1 AND site_url = $2`,
			["org_a", SITE],
		),
	)
	const writtenRows = () => Arr.flatMap(writes, (write) => write.rows)
	return { layer, google, writes, writtenRows, sql, siteState, nextAttemptOf, backoffOf }
}

/** Connect Google at NOW and enable the one property. */
const connectSite = Effect.gen(function* () {
	yield* TestClock.setTime(NOW)
	const google = yield* GoogleOAuthService
	const { state } = yield* google.startConnect(orgA, userA, { callbackUrl: "https://api.example.com/cb" })
	yield* google.completeConnect("code", state, { orgId: orgA, userId: userA })
	yield* (yield* SearchConsoleService).saveSites(orgA, [Schema.decodeSync(SearchConsoleSiteUrl)(SITE)])
})

const poll = SearchConsoleImportService.use((service) => service.pollAllSites)

/** Advance the test clock in small steps until the forked run settles, waiting on real I/O in between. */
const settleWithClock = <A, E>(fiber: Fiber.Fiber<A, E>) =>
	Effect.gen(function* () {
		yield* Effect.repeat(
			Effect.gen(function* () {
				yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
				if (fiber.pollUnsafe() !== undefined) return true
				yield* TestClock.adjust(Duration.millis(250))
				return false
			}),
			{ until: (done) => done, times: 2_000 },
		)
		return yield* Fiber.join(fiber)
	})

/** Fork `effect`, wait until a hanging Search Analytics request is in flight, then interrupt it. */
const killWhenHung = <A, E, R>(
	google: { readonly nextHang: () => Promise<void> },
	effect: Effect.Effect<A, E, R>,
) =>
	Effect.gen(function* () {
		const inFlight = google.nextHang()
		const fiber = yield* Effect.forkChild(effect)
		yield* Effect.promise(() => inFlight)
		yield* Fiber.interrupt(fiber)
	})

const ranges = (queries: ReadonlyArray<SearchAnalyticsBody>) =>
	Arr.map(queries, (query) => [query.startDate, query.endDate, Arr.join(query.dimensions, ",")])

describe("SearchConsoleImportService", () => {
	it.effect("imports the first two weeks at every grain and seeds both frontiers", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectSite
			const summary = yield* poll
			// One day at a time, oldest first, every grain of a day before the next day.
			assert.deepStrictEqual(
				ranges(h.google.queries),
				Arr.flatMap(daysOf("2026-10-26", "2026-11-08"), (day) => [
					[day, day, "date,country,device"],
					[day, day, "date,page"],
					[day, day, "date,page,query,country,device"],
				]),
			)
			assert.isTrue(Arr.every(h.google.queries, (query) => query.dataState === "all"))
			assert.deepStrictEqual(
				{ imported: summary.imported, rowsWritten: summary.rowsWritten, days: summary.days },
				{ imported: 1, rowsWritten: 42, days: 14 },
			)
			assert.isTrue(Arr.every(h.writes, (write) => write.datasource === "search_console_daily"))
			const siteRow = Arr.findFirst(
				h.writtenRows(),
				(row) => row.Grain === "site" && row.Date === "2026-11-08 00:00:00",
			)
			assert.deepStrictEqual(
				Option.map(siteRow, (row) => ({ ...row, IngestedAt: "" })),
				Option.some({
					OrgId: "org_a",
					SiteUrl: SITE,
					Grain: "site",
					SearchType: "web",
					Date: "2026-11-08 00:00:00",
					Page: "",
					Query: "",
					Country: "usa",
					Device: "desktop",
					Clicks: 3,
					Impressions: 40,
					PositionSum: 100,
					IngestedAt: "",
				}),
			)
			const pageRow = Arr.findFirst(
				h.writtenRows(),
				(row) => row.Grain === "page" && row.Date === "2026-11-08 00:00:00",
			)
			assert.deepStrictEqual(
				Option.map(pageRow, (row) => [row.Page, row.Country, row.Device, row.Clicks]),
				Option.some(["https://acme.dev/pricing", "", "", 3]),
			)
			assert.deepStrictEqual(yield* h.siteState, {
				watermark: "2026-11-08",
				backfill: "2026-10-26",
				synced: String(NOW),
				lease: null,
				error: null,
			})
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("backfills while the head is current, then re-fetches the trailing three days", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectSite
			yield* poll
			yield* TestClock.adjust("15 minutes")
			yield* poll
			yield* TestClock.adjust("6 hours")
			yield* poll
			// Head walks up from its start; backfill walks down from its end.
			assert.deepStrictEqual(
				Arr.map(
					Arr.filter(h.google.queries, (query) => query.dimensions.length === 3),
					(query) => query.startDate,
				),
				[
					...daysOf("2026-10-26", "2026-11-08"),
					...Arr.reverse(daysOf("2026-10-12", "2026-10-25")),
					...daysOf("2026-11-05", "2026-11-08"),
				],
			)
			const state = yield* h.siteState
			assert.deepStrictEqual([state?.watermark, state?.backfill], ["2026-11-08", "2026-10-12"])
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("pages through every row Google has past a full page", () => {
		const h = harness({ queryRowsTotal: 25_010 })
		return Effect.gen(function* () {
			yield* connectSite
			yield* poll
			const queryPages = Arr.filter(
				h.google.queries,
				(query) => query.dimensions.includes("query") && query.startDate === PAGED_DAY,
			)
			assert.deepStrictEqual(
				Arr.map(queryPages, (query) => query.startRow),
				[0, 25_000],
			)
			const queryRows = Arr.filter(
				h.writtenRows(),
				(row) => row.Grain === "query" && row.Date === `${PAGED_DAY} 00:00:00`,
			)
			assert.strictEqual(queryRows.length, 25_010)
			assert.strictEqual(new Set(Arr.map(queryRows, (row) => row.Query)).size, 25_010)
			assert.isTrue(Arr.every(h.writes, (write) => write.rows.length <= 10_000))
			// One import, one IngestedAt, across every grain, page and batch.
			assert.isAbove(h.writes.length, 3)
			assert.strictEqual(new Set(Arr.map(h.writtenRows(), (row) => row.IngestedAt)).size, 1)
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("stops the backfill at Google's 16-month limit", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectSite
			yield* h.sql(
				"UPDATE search_console_sites SET watermark_date = '2026-11-08', backfill_date = '2025-07-13', last_synced_at = to_timestamp($1 / 1000.0)",
				[NOW],
			)
			yield* poll
			assert.deepStrictEqual(
				Arr.dedupe(Arr.map(h.google.queries, (query) => query.startDate)),
				Arr.reverse(daysOf("2025-07-08", "2025-07-12")),
			)
			assert.strictEqual((yield* h.siteState)?.backfill, "2025-07-08")
			const after = yield* poll
			assert.deepStrictEqual([after.due, h.google.queries.length], [0, 15])
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("leaves a property another tick holds, and two concurrent ticks import it once", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectSite
			yield* h.sql("UPDATE search_console_sites SET lease_until = to_timestamp($1 / 1000.0)", [
				NOW + 10 * 60_000,
			])
			const held = yield* poll
			assert.deepStrictEqual([held.due, h.google.queries.length], [0, 0])

			yield* h.sql("UPDATE search_console_sites SET lease_until = NULL")
			const ticks = yield* Effect.all([poll, poll], { concurrency: "unbounded" })
			assert.strictEqual(
				Arr.reduce(ticks, 0, (sum, tick) => sum + tick.imported),
				1,
			)
			assert.strictEqual(h.google.queries.length, 14 * 3)
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("skips properties whose Google grant is revoked", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectSite
			yield* h.sql("UPDATE oauth_connections SET revoked_at = now() WHERE org_id = $1", ["org_a"])
			const summary = yield* poll
			assert.deepStrictEqual([summary.due, h.google.queries.length, h.writes.length], [0, 0, 0])
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("records a Google failure without moving the watermark", () => {
		const h = harness({ failStatus: 500 })
		return Effect.gen(function* () {
			yield* connectSite
			const lastSynced = NOW - 7 * 60 * 60_000
			yield* h.sql(
				"UPDATE search_console_sites SET watermark_date = '2026-11-01', backfill_date = '2026-10-19', last_synced_at = to_timestamp($1 / 1000.0)",
				[lastSynced],
			)
			const summary = yield* poll
			assert.strictEqual(summary.failures, 1)
			assert.deepStrictEqual(yield* h.siteState, {
				watermark: "2026-11-01",
				backfill: "2026-10-19",
				synced: String(lastSynced),
				lease: null,
				error: "Search Console returned 500",
			})
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("holds a property out of the next tick when Google's quota is spent", () => {
		const h = harness({ failStatus: 429 })
		return Effect.gen(function* () {
			yield* connectSite
			yield* poll
			const state = yield* h.siteState
			assert.deepStrictEqual(
				[state?.watermark, state?.error, state?.lease],
				[null, "Search Console quota exceeded", null],
			)
			assert.strictEqual(yield* h.nextAttemptOf(SITE), String(NOW + 25 * 60_000))
			yield* TestClock.adjust("15 minutes")
			assert.strictEqual((yield* poll).due, 0)
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("backs a failing property off longer after each failure, and a success resets it", () => {
		const h = harness({ failingSites: [SITE] })
		return Effect.gen(function* () {
			yield* connectSite
			yield* poll
			assert.strictEqual(yield* h.nextAttemptOf(SITE), String(NOW + 15 * 60_000))
			yield* TestClock.adjust("15 minutes")
			yield* poll
			assert.strictEqual(yield* h.nextAttemptOf(SITE), String(NOW + 15 * 60_000 + 30 * 60_000))
			yield* TestClock.adjust("15 minutes")
			assert.strictEqual((yield* poll).due, 0)
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("twenty-plus failing properties do not keep a healthy one from importing", () => {
		const h = harness({
			failingSites: Arr.map(Arr.range(0, 24), (index) => `sc-domain:fail-${index}.dev`),
		})
		return Effect.gen(function* () {
			yield* connectSite
			// Failing properties that would sort first by age: never synced, older rows.
			yield* h.sql(
				`INSERT INTO search_console_sites
				   (id, org_id, oauth_connection_id, site_url, permission_level, last_error, created_at, updated_at)
				 SELECT '0190f2b3-0000-7000-8000-' || lpad(n::text, 12, '0'), 'org_a', c.id, 'sc-domain:fail-' || n || '.dev', 'siteOwner',
				        'Search Console returned 500', to_timestamp($1 / 1000.0), to_timestamp($1 / 1000.0)
				   FROM generate_series(0, 24) AS n, oauth_connections c WHERE c.org_id = 'org_a'`,
				[NOW - 24 * 60 * 60_000],
			)
			const summary = yield* poll
			assert.strictEqual(summary.due, 20)
			assert.strictEqual(summary.imported, 1)
			assert.strictEqual((yield* h.siteState)?.watermark, "2026-11-08")
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("saving the picker does not shorten a failing property's backoff", () => {
		const h = harness({ failingSites: [SITE] })
		return Effect.gen(function* () {
			yield* connectSite
			yield* poll
			yield* TestClock.adjust("15 minutes")
			yield* poll
			// Two failures: the third attempt waits 30 minutes, then the next one an hour.
			yield* TestClock.adjust("30 minutes")
			yield* (yield* SearchConsoleService).saveSites(orgA, [
				Schema.decodeSync(SearchConsoleSiteUrl)(SITE),
			])
			yield* poll
			assert.strictEqual(yield* h.nextAttemptOf(SITE), String(NOW + 45 * 60_000 + 60 * 60_000))
		}).pipe(Effect.provide(h.layer))
	})

	it.effect(
		"a failure on a day's second page writes nothing for that day and keeps the days before",
		() => {
			const h = harness({
				queryRowsTotal: 25_010,
				pagedDay: "2026-10-30",
				failPage: { day: "2026-10-30", startRow: 25_000 },
			})
			return Effect.gen(function* () {
				yield* connectSite
				const summary = yield* poll
				assert.strictEqual(summary.failures, 1)
				// Every grain of the four whole days, nothing of the failed day or after it.
				assert.deepStrictEqual(
					Arr.dedupe(Arr.map(h.writtenRows(), (row) => `${row.Date}|${row.Grain}`)),
					Arr.flatMap(daysOf("2026-10-26", "2026-10-29"), (day) => [
						`${day} 00:00:00|site`,
						`${day} 00:00:00|page`,
						`${day} 00:00:00|query`,
					]),
				)
				const state = yield* h.siteState
				assert.deepStrictEqual(
					[state?.watermark, state?.backfill, state?.synced, state?.error],
					["2026-10-29", "2026-10-26", null, "Search Console returned 500"],
				)
			}).pipe(Effect.provide(h.layer))
		},
	)

	it.effect("a backfill that fails part-way moves its frontier down over the whole days only", () => {
		const h = harness({ failDays: ["2026-10-20"] })
		return Effect.gen(function* () {
			yield* connectSite
			yield* h.sql(
				"UPDATE search_console_sites SET watermark_date = '2026-11-08', backfill_date = '2026-10-26', last_synced_at = to_timestamp($1 / 1000.0)",
				[NOW],
			)
			yield* poll
			assert.deepStrictEqual(
				Arr.dedupe(Arr.map(h.writtenRows(), (row) => row.Date)),
				Arr.map(Arr.reverse(daysOf("2026-10-21", "2026-10-25")), (day) => `${day} 00:00:00`),
			)
			const state = yield* h.siteState
			assert.deepStrictEqual([state?.watermark, state?.backfill], ["2026-11-08", "2026-10-21"])
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("an import killed mid-way backs the property off, longer each time", () => {
		const h = harness({ hang: true })
		const killedTick = Effect.gen(function* () {
			const inFlight = h.google.nextHang()
			const fiber = yield* Effect.forkChild(poll)
			yield* Effect.promise(() => inFlight)
			yield* Fiber.interrupt(fiber)
		})
		return Effect.gen(function* () {
			yield* connectSite
			yield* killedTick
			assert.strictEqual(yield* h.nextAttemptOf(SITE), String(NOW + 15 * 60_000))
			// Past the lease and the first backoff: the next tick retries, and is killed again.
			yield* TestClock.adjust("16 minutes")
			yield* killedTick
			const second = NOW + 16 * 60_000
			assert.strictEqual(yield* h.nextAttemptOf(SITE), String(second + 30 * 60_000))
			yield* TestClock.adjust("16 minutes")
			assert.strictEqual((yield* poll).due, 0)
		}).pipe(Effect.provide(h.layer))
	})
})

describe("SearchConsoleImportService frontier and writes", () => {
	it.effect("an import cut off after two days keeps them, and the next run starts after them", () => {
		const h = harness({ hangDaysOnce: ["2026-10-23"] })
		return Effect.gen(function* () {
			yield* connectSite
			yield* h.sql(
				"UPDATE search_console_sites SET watermark_date = '2026-11-08', backfill_date = '2026-10-26', last_synced_at = to_timestamp($1 / 1000.0)",
				[NOW],
			)
			yield* killWhenHung(h.google, poll)
			const cut = yield* h.siteState
			assert.deepStrictEqual([cut?.watermark, cut?.backfill], ["2026-11-08", "2026-10-24"])
			// Past the lease and the backoff: the next tick resumes below the two whole days.
			yield* TestClock.adjust("16 minutes")
			const before = h.google.queries.length
			yield* poll
			assert.deepStrictEqual(
				Arr.dedupe(Arr.map(h.google.queries.slice(before), (query) => query.startDate)),
				Arr.reverse(daysOf("2026-10-10", "2026-10-23")),
			)
			assert.strictEqual((yield* h.siteState)?.backfill, "2026-10-10")
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("a head cut off part-way keeps its advanced watermark but is not synced", () => {
		const h = harness({ hangDaysOnce: ["2026-10-28"] })
		return Effect.gen(function* () {
			yield* connectSite
			yield* killWhenHung(h.google, poll)
			const state = yield* h.siteState
			assert.deepStrictEqual(
				[state?.watermark, state?.backfill, state?.synced],
				["2026-10-27", "2026-10-26", null],
			)
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("an ingest batch that fails once is sent again and the day completes", () => {
		// Thirteen one-batch days, then today's 25,012 rows in three batches; its second fails once.
		const h = harness({ queryRowsTotal: 25_010, failIngestCallOnce: 13 + 2 })
		return Effect.gen(function* () {
			yield* connectSite
			const summary = yield* settleWithClock(yield* Effect.forkChild(poll))
			assert.deepStrictEqual([summary.imported, summary.failures, summary.days], [1, 0, 14])
			const queryRows = Arr.filter(
				h.writtenRows(),
				(row) => row.Grain === "query" && row.Date === `${PAGED_DAY} 00:00:00`,
			)
			assert.strictEqual(new Set(Arr.map(queryRows, (row) => row.Query)).size, 25_010)
			const state = yield* h.siteState
			assert.deepStrictEqual([state?.watermark, state?.error], ["2026-11-08", null])
		}).pipe(Effect.provide(h.layer))
	})

	it.effect(
		"a day with more rows than four pages fails with the row limit and writes nothing of it",
		() => {
			const h = harness({ queryRowsTotal: 100_001 })
			return Effect.gen(function* () {
				yield* connectSite
				const summary = yield* poll
				assert.strictEqual(summary.failures, 1)
				assert.deepStrictEqual(
					Arr.map(
						Arr.filter(
							h.google.queries,
							(query) => query.dimensions.includes("query") && query.startDate === PAGED_DAY,
						),
						(query) => query.startRow,
					),
					[0, 25_000, 50_000, 75_000],
				)
				assert.isFalse(Arr.some(h.writtenRows(), (row) => row.Date === `${PAGED_DAY} 00:00:00`))
				const state = yield* h.siteState
				assert.deepStrictEqual(
					[state?.watermark, state?.error],
					["2026-11-07", "Google returned more than 100000 query rows for 2026-11-08"],
				)
			}).pipe(Effect.provide(h.layer))
		},
	)
})

const importOrg = (orgId: OrgId) => SearchConsoleImportService.use((service) => service.importOrg(orgId))

describe("SearchConsoleImportService.importOrg", () => {
	it.effect("imports only that org's properties", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectSite
			// org_b's property under its own grant, due as much as org_a's.
			yield* h.sql(
				"CREATE TEMP TABLE grant_b AS SELECT * FROM oauth_connections WHERE org_id = 'org_a'",
			)
			yield* h.sql("UPDATE grant_b SET id = 'grant-b', org_id = 'org_b'")
			yield* h.sql("INSERT INTO oauth_connections SELECT * FROM grant_b")
			yield* h.sql(
				`INSERT INTO search_console_sites (id, org_id, oauth_connection_id, site_url, permission_level, created_at, updated_at)
				 SELECT '0190f2b3-0000-7000-8000-00000000000b', 'org_b', c.id, 'sc-domain:other.dev', 'siteOwner', now(), now()
				   FROM oauth_connections c WHERE c.org_id = 'org_b'`,
			)
			const summary = yield* importOrg(orgA)
			assert.deepStrictEqual([summary.connected, summary.due, summary.imported], [true, 1, 1])
			assert.deepStrictEqual(Arr.dedupe(h.google.querySites), [SITE])
			assert.strictEqual((yield* h.siteState)?.watermark, "2026-11-08")
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("leaves a property a running tick holds", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectSite
			yield* h.sql("UPDATE search_console_sites SET lease_until = to_timestamp($1 / 1000.0)", [
				NOW + 10 * 60_000,
			])
			const summary = yield* importOrg(orgA)
			assert.deepStrictEqual([summary.due, h.google.queries.length], [0, 0])
			assert.strictEqual((yield* h.siteState)?.lease, String(NOW + 10 * 60_000))
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("runs a first import its backoff would hold, but not a later one", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectSite
			yield* h.sql(
				"UPDATE search_console_sites SET next_attempt_at = to_timestamp($1 / 1000.0), consecutive_failures = 3",
				[NOW + 60 * 60_000],
			)
			assert.strictEqual((yield* poll).due, 0)
			const first = yield* importOrg(orgA)
			assert.strictEqual(first.imported, 1)
			assert.strictEqual(yield* h.nextAttemptOf(SITE), null)

			// Imported once: a backoff now holds the prime as it holds the tick.
			yield* TestClock.adjust("7 hours")
			yield* h.sql("UPDATE search_console_sites SET next_attempt_at = to_timestamp($1 / 1000.0)", [
				NOW + 8 * 60 * 60_000,
			])
			const later = yield* importOrg(orgA)
			assert.deepStrictEqual([later.due, h.google.queries.length], [0, 14 * 3])
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("a prime cut off part-way leaves the cron's backoff as it was and keeps its days", () => {
		const h = harness({ hangDaysOnce: ["2026-10-28"] })
		return Effect.gen(function* () {
			yield* connectSite
			yield* h.sql(
				"UPDATE search_console_sites SET next_attempt_at = to_timestamp($1 / 1000.0), consecutive_failures = 2",
				[NOW + 60 * 60_000],
			)
			yield* killWhenHung(h.google, importOrg(orgA))
			assert.deepStrictEqual(yield* h.backoffOf, { failures: 2, next: String(NOW + 60 * 60_000) })
			const state = yield* h.siteState
			assert.deepStrictEqual(
				[state?.watermark, state?.lease],
				["2026-10-27", String(NOW + 15 * 60_000)],
			)
			// Its lease still holds the property, so a tick cannot import it twice.
			yield* h.sql("UPDATE search_console_sites SET next_attempt_at = NULL")
			assert.strictEqual((yield* poll).due, 0)
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("a failed prime records the error but leaves the cron's backoff as it was", () => {
		const h = harness({ failStatus: 500 })
		return Effect.gen(function* () {
			yield* connectSite
			yield* h.sql(
				"UPDATE search_console_sites SET next_attempt_at = to_timestamp($1 / 1000.0), consecutive_failures = 2",
				[NOW + 60 * 60_000],
			)
			const summary = yield* importOrg(orgA)
			assert.strictEqual(summary.failures, 1)
			assert.deepStrictEqual(yield* h.backoffOf, { failures: 2, next: String(NOW + 60 * 60_000) })
			const state = yield* h.siteState
			assert.deepStrictEqual([state?.error, state?.lease], ["Search Console returned 500", null])
		}).pipe(Effect.provide(h.layer))
	})

	it.effect("reports an org without a live grant as not connected", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectSite
			yield* h.sql("UPDATE oauth_connections SET revoked_at = now() WHERE org_id = $1", ["org_a"])
			const summary = yield* importOrg(orgA)
			assert.deepStrictEqual([summary.connected, summary.due, h.google.queries.length], [false, 0, 0])
		}).pipe(Effect.provide(h.layer))
	})
})

describe("planImport", () => {
	it("restarts a head left far behind at Google's 16-month floor", () => {
		const plan = planImport(
			{ watermarkDate: "2025-01-01", backfillDate: "2024-12-01", lastSyncedAt: NOW - 400 * 86_400_000 },
			NOW,
			6 * 60 * 60_000,
		)
		assert.deepStrictEqual(plan, { mode: "head", startDate: "2025-07-08", endDate: "2025-07-21" })
	})
})
