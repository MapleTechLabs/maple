import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Array as Arr } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { listSites, querySearchAnalytics, type SearchAnalyticsQuery } from "./client"

interface Recorded {
	readonly url: string
	readonly method: string
	readonly authorization: string | null
	/** The parsed JSON body, typed to the fields the assertions read. */
	readonly body: { readonly startRow?: number; readonly rowLimit?: number } | null
}

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** A fake Google answering every request with `respond`, recording what it was sent. */
const fakeGoogle = (respond: (request: Recorded) => Response) => {
	const requests: Recorded[] = []
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init)
		const text = request.method === "GET" ? "" : await request.text()
		const recorded = {
			url: request.url,
			method: request.method,
			authorization: request.headers.get("authorization"),
			body: text === "" ? null : JSON.parse(text),
		}
		requests.push(recorded)
		return respond(recorded)
	}
	const layer = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
	return { requests, layer }
}

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
			jsonResponse({
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
			assert.strictEqual(google.requests[0]?.url, "https://www.googleapis.com/webmasters/v3/sites")
			assert.strictEqual(google.requests[0]?.authorization, "Bearer token-1")
		}).pipe(Effect.provide(google.layer))
	})

	it.effect("reads an account with no properties as an empty list", () => {
		const google = fakeGoogle(() => jsonResponse({}))
		return Effect.gen(function* () {
			assert.deepStrictEqual(yield* listSites(yield* HttpClient.HttpClient, "token-1"), [])
		}).pipe(Effect.provide(google.layer))
	})

	it.effect("fails a 401 as a rejected token so the caller can refresh", () => {
		const google = fakeGoogle(() => jsonResponse({ error: { code: 401 } }, 401))
		return Effect.gen(function* () {
			const error = yield* listSites(yield* HttpClient.HttpClient, "stale").pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/backend/integrations/SearchConsoleTokenRejectedError")
		}).pipe(Effect.provide(google.layer))
	})

	it.effect("fails a quota answer as an API error carrying the status", () => {
		const google = fakeGoogle(() => jsonResponse({ error: { code: 429 } }, 429))
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
			const startRow = request.body?.startRow
			return jsonResponse({ rows: startRow === 0 ? [row(1), row(2), row(3)] : [row(4)] })
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
				google.requests[0]?.url,
				"https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aacme.dev/searchAnalytics/query",
			)
			assert.strictEqual(google.requests[0]?.method, "POST")
			assert.deepStrictEqual(
				Arr.map(google.requests, (request) => request.body),
				[
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
				],
			)
		}).pipe(Effect.provide(google.layer))
	})

	it.effect("asks for Google's maximum page size when no row limit is given", () => {
		const google = fakeGoogle(() => jsonResponse({}))
		return Effect.gen(function* () {
			const { rowLimit: _omitted, ...query } = QUERY
			const page = yield* querySearchAnalytics(
				yield* HttpClient.HttpClient,
				"token-1",
				"https://acme.dev/",
				query,
			)
			assert.deepStrictEqual(page, { rows: [], nextStartRow: null })
			assert.strictEqual(google.requests[0]?.body?.rowLimit, 25_000)
			assert.strictEqual(
				google.requests[0]?.url,
				"https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Facme.dev%2F/searchAnalytics/query",
			)
		}).pipe(Effect.provide(google.layer))
	})
})
