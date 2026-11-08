import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, DateTime, Effect, Layer, Option, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { OrgId, UserId } from "@maple/domain/http"
import { SearchConsoleSiteUrl } from "@maple/domain/primitives"
import type { SearchConsoleDailyRow } from "@maple/domain/tinybird"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { GoogleOAuthService } from "@maple/backend/services/auth/GoogleOAuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { addDays, daysBetween } from "./google-search-console/import-plan"
import { SearchConsoleImportService } from "./SearchConsoleImportService"
import { SearchConsoleService } from "./SearchConsoleService"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

// 04:00 in Pacific time, so Google's day is 2026-11-08 too.
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-08T12:00:00Z"))
const SITE = "sc-domain:acme.dev"
const SCOPE = "openid email https://www.googleapis.com/auth/webmasters.readonly"
const ID_TOKEN = `h.${Buffer.from(JSON.stringify({ sub: "g-1", email: "owner@acme.dev" })).toString("base64url")}.s`

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

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

const readBody = (url: string, init?: RequestInit) =>
	new Request(url, {
		method: "POST",
		body: init?.body,
		// @ts-expect-error duplex is required for streaming bodies in undici/Bun
		duplex: "half",
	}).text()

const daysOf = (start: string, end: string) =>
	Arr.map(Arr.range(0, daysBetween(start, end) - 1), (offset) => addDays(start, offset))

interface FakeGoogleOptions {
	/** Rows the query grain holds in total, served page by page; one per day when unset. */
	readonly queryRowsTotal?: number
	/** Status every Search Analytics request answers with. */
	readonly failStatus?: number
}

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
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		if (url === "https://oauth2.googleapis.com/token") {
			return jsonResponse({
				access_token: "g-access",
				refresh_token: "g-refresh",
				expires_in: 3599,
				scope: SCOPE,
				id_token: ID_TOKEN,
			})
		}
		if (url === "https://www.googleapis.com/webmasters/v3/sites") {
			return jsonResponse({ siteEntry: [{ siteUrl: SITE, permissionLevel: "siteOwner" }] })
		}
		if (Str.endsWith("/searchAnalytics/query")(url)) {
			const body = decodeBody(await readBody(url, init))
			queries.push(body)
			if (options.failStatus !== undefined) return jsonResponse({}, options.failStatus)
			const keys = (day: string, query: string) =>
				Arr.map(body.dimensions, (dimension) => keyFor(dimension, day, query))
			const total = body.dimensions.includes("query") ? options.queryRowsTotal : undefined
			if (total === undefined) {
				return jsonResponse({
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
			return jsonResponse({
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
		return jsonResponse({}, 404)
	}
	return { fetch, queries }
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
	GOOGLE_OAUTH_CLIENT_ID: "g-client-id",
	GOOGLE_OAUTH_CLIENT_SECRET: "g-client-secret",
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
		readonly rows: ReadonlyArray<SearchConsoleDailyRow>
	}> = []
	const warehouse = Layer.succeed(
		WarehouseQueryService,
		makeWarehouseServiceStub({
			ingest: (_tenant, datasource, rows) =>
				Effect.sync(() => {
					// SAFETY: the importer only ever writes search_console_daily rows.
					writes.push({ datasource, rows: rows as ReadonlyArray<SearchConsoleDailyRow> })
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
		Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, google.fetch)),
	)
	const sql = (statement: string, params: unknown[] = []) =>
		Effect.promise(() => executeSql(testDb, statement, params))
	const siteState = Effect.promise(() =>
		queryFirstRow<SiteState>(
			testDb,
			`SELECT watermark_date AS watermark, backfill_date AS backfill,
			        (extract(epoch from last_synced_at) * 1000)::bigint::text AS synced,
			        (extract(epoch from lease_until) * 1000)::bigint::text AS lease, last_error AS error
			   FROM search_console_sites WHERE org_id = $1`,
			["org_a"],
		),
	)
	const writtenRows = () => Arr.flatMap(writes, (write) => write.rows)
	return { layer, google, writes, writtenRows, sql, siteState }
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

const ranges = (queries: ReadonlyArray<SearchAnalyticsBody>) =>
	Arr.map(queries, (query) => [query.startDate, query.endDate, Arr.join(query.dimensions, ",")])

describe("SearchConsoleImportService", () => {
	it.effect("imports the first two weeks at every grain and seeds both frontiers", () => {
		const h = harness()
		return Effect.gen(function* () {
			yield* connectSite
			const summary = yield* poll
			assert.deepStrictEqual(ranges(h.google.queries), [
				["2026-10-26", "2026-11-08", "date,country,device"],
				["2026-10-26", "2026-11-08", "date,page,country,device"],
				["2026-10-26", "2026-11-08", "date,page,query,country,device"],
			])
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
			assert.deepStrictEqual(
				Arr.map(
					Arr.filter(h.google.queries, (query) => query.dimensions.length === 3),
					(query) => [query.startDate, query.endDate],
				),
				[
					["2026-10-26", "2026-11-08"],
					["2026-10-12", "2026-10-25"],
					["2026-11-05", "2026-11-08"],
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
			const queryPages = Arr.filter(h.google.queries, (query) => query.dimensions.includes("query"))
			assert.deepStrictEqual(
				Arr.map(queryPages, (query) => query.startRow),
				[0, 25_000],
			)
			const queryRows = Arr.filter(h.writtenRows(), (row) => row.Grain === "query")
			assert.strictEqual(queryRows.length, 25_010)
			assert.strictEqual(new Set(Arr.map(queryRows, (row) => row.Query)).size, 25_010)
			assert.isTrue(Arr.every(h.writes, (write) => write.rows.length <= 10_000))
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
			assert.deepStrictEqual(Arr.dedupe(Arr.map(h.google.queries, (query) => query.startDate)), [
				"2025-07-08",
			])
			assert.strictEqual((yield* h.siteState)?.backfill, "2025-07-08")
			const after = yield* poll
			assert.deepStrictEqual([after.due, h.google.queries.length], [0, 3])
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
			assert.strictEqual(h.google.queries.length, 3)
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
				[null, "Search Console quota exceeded", String(NOW + 25 * 60_000)],
			)
			yield* TestClock.adjust("15 minutes")
			assert.strictEqual((yield* poll).due, 0)
		}).pipe(Effect.provide(h.layer))
	})
})
