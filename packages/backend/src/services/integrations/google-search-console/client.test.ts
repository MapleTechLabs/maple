import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema, Array as Arr } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import * as VendorFake from "@maple/backend/testing/vendor-fake"
import { listSites, querySearchAnalytics, type SearchAnalyticsQuery } from "./client"

const parseBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const decodeQueryBody = Schema.decodeUnknownSync(
	Schema.Struct({ startRow: Schema.Number, rowLimit: Schema.Number }),
)

/** A fake Google answering every request with `respond`. */
const fakeGoogle = (respond: (request: VendorFake.VendorFakeRequest) => Response) => {
	const fake = VendorFake.make({ routes: [{ respond }] })
	return { fake, layer: Layer.merge(FetchHttpClient.layer, fake.layer) }
}

const bodyOf = (request: VendorFake.VendorFakeRequest | undefined) =>
	request === undefined || request.body === "" ? null : parseBody(request.body)

const row = (n: number) => ({
	keys: ["2026-11-01", `query ${n}`],
	clicks: n,
	impressions: n * 10,
	ctr: 0.1,
	position: 4.2,
})

const QUERY: SearchAnalyticsQuery = {
	startDate: "2026-11-01",
	endDate: "2026-11-01",
	dimensions: ["date", "query"],
	startRow: 0,
	dataState: "final",
	rowLimit: 3,
}

describe("Search Console client", () => {
	it.effect("lists the account's properties with their permission level", () => {
		const google = fakeGoogle(() =>
			VendorFake.json({
				siteEntry: [
					{ siteUrl: "sc-domain:acme.dev", permissionLevel: "siteOwner" },
					{ siteUrl: "https://blog.acme.dev/", permissionLevel: "siteFullUser" },
				],
			}),
		)
		return Effect.gen(function* () {
			const sites = yield* listSites(yield* HttpClient.HttpClient, "token-1")
			assert.deepStrictEqual(
				Arr.map(sites, (site) => site.siteUrl),
				["sc-domain:acme.dev", "https://blog.acme.dev/"],
			)
			assert.strictEqual(
				google.fake.calls[0]?.url.href,
				"https://www.googleapis.com/webmasters/v3/sites",
			)
			assert.strictEqual(google.fake.calls[0]?.authorization, "Bearer token-1")
		}).pipe(Effect.provide(google.layer))
	})

	it.effect("reads an account with no properties as an empty list", () => {
		const google = fakeGoogle(() => VendorFake.json({}))
		return Effect.gen(function* () {
			assert.deepStrictEqual(yield* listSites(yield* HttpClient.HttpClient, "token-1"), [])
		}).pipe(Effect.provide(google.layer))
	})

	it.effect("fails a 401 as a rejected token so the caller can refresh", () => {
		const google = fakeGoogle(() => VendorFake.json({ error: { code: 401 } }, 401))
		return Effect.gen(function* () {
			const error = yield* listSites(yield* HttpClient.HttpClient, "stale").pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/backend/integrations/SearchConsoleTokenRejectedError")
		}).pipe(Effect.provide(google.layer))
	})

	it.effect("fails a quota answer as an API error carrying the status", () => {
		const google = fakeGoogle(() => VendorFake.json({ error: { code: 429 } }, 429))
		return Effect.gen(function* () {
			const error = yield* listSites(yield* HttpClient.HttpClient, "token-1").pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/backend/integrations/SearchConsoleApiError")
			assert.strictEqual(
				error._tag === "@maple/backend/integrations/SearchConsoleApiError" && error.status,
				429,
			)
		}).pipe(Effect.provide(google.layer))
	})

	it.effect("posts the query to the encoded property path and pages by startRow", () => {
		const google = fakeGoogle((request) => {
			const startRow = decodeQueryBody(bodyOf(request)).startRow
			return VendorFake.json({ rows: startRow === 0 ? [row(1), row(2), row(3)] : [row(4)] })
		})
		return Effect.gen(function* () {
			const httpClient = yield* HttpClient.HttpClient
			const first = yield* querySearchAnalytics(httpClient, "token-1", "sc-domain:acme.dev", QUERY)
			assert.strictEqual(first.rows.length, 3)
			assert.strictEqual(first.nextStartRow, 3)
			const second = yield* querySearchAnalytics(httpClient, "token-1", "sc-domain:acme.dev", {
				...QUERY,
				startRow: 3,
			})
			assert.deepStrictEqual(second.rows[0]?.keys, ["2026-11-01", "query 4"])
			assert.isNull(second.nextStartRow)

			assert.strictEqual(
				google.fake.calls[0]?.url.href,
				"https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aacme.dev/searchAnalytics/query",
			)
			assert.strictEqual(google.fake.calls[0]?.method, "POST")
			assert.deepStrictEqual(Arr.map(google.fake.calls, bodyOf), [
				{
					startDate: "2026-11-01",
					endDate: "2026-11-01",
					dimensions: ["date", "query"],
					rowLimit: 3,
					startRow: 0,
					dataState: "final",
				},
				{
					startDate: "2026-11-01",
					endDate: "2026-11-01",
					dimensions: ["date", "query"],
					rowLimit: 3,
					startRow: 3,
					dataState: "final",
				},
			])
		}).pipe(Effect.provide(google.layer))
	})

	it.effect("asks for Google's maximum page size when no row limit is given", () => {
		const google = fakeGoogle(() => VendorFake.json({}))
		return Effect.gen(function* () {
			const { rowLimit: _omitted, ...query } = QUERY
			const page = yield* querySearchAnalytics(
				yield* HttpClient.HttpClient,
				"token-1",
				"https://acme.dev/",
				query,
			)
			assert.deepStrictEqual(page, { rows: [], nextStartRow: null })
			assert.strictEqual(decodeQueryBody(bodyOf(google.fake.calls[0])).rowLimit, 25_000)
			assert.strictEqual(
				google.fake.calls[0]?.url.href,
				"https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Facme.dev%2F/searchAnalytics/query",
			)
		}).pipe(Effect.provide(google.layer))
	})

	it.effect("lists properties again after a passing 5xx", () => {
		let served = 0
		const google = fakeGoogle(() => {
			served++
			return served === 1
				? VendorFake.json({ error: { message: "Backend Error" } }, 503)
				: VendorFake.json({ siteEntry: [] })
		})
		return Effect.gen(function* () {
			const sites = yield* VendorFake.elapsing(listSites(yield* HttpClient.HttpClient, "token-1"))
			assert.deepStrictEqual(sites, [])
			assert.strictEqual(google.fake.calls.length, 2)
		}).pipe(Effect.provide(google.layer))
	})

	it.effect("sends a Search Analytics query once, leaving a 5xx to the import's backoff", () => {
		const google = fakeGoogle(() => VendorFake.json({ error: { message: "Backend Error" } }, 503))
		return Effect.gen(function* () {
			const error = yield* querySearchAnalytics(
				yield* HttpClient.HttpClient,
				"token-1",
				"sc-domain:acme.dev",
				QUERY,
			).pipe(Effect.flip)
			assert.strictEqual(error.message, "Search Console returned 503: Backend Error")
			assert.strictEqual(google.fake.calls.length, 1)
		}).pipe(Effect.provide(google.layer))
	})

	it.effect("names Google's own message when it refuses a request", () => {
		const google = fakeGoogle(() =>
			VendorFake.json({ error: { code: 400, message: "Invalid dimension: hour" } }, 400),
		)
		return Effect.gen(function* () {
			const error = yield* querySearchAnalytics(
				yield* HttpClient.HttpClient,
				"token-1",
				"sc-domain:acme.dev",
				QUERY,
			).pipe(Effect.flip)
			assert.strictEqual(error.message, "Search Console returned 400: Invalid dimension: hour")
		}).pipe(Effect.provide(google.layer))
	})
})
