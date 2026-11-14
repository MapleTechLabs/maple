import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema, Stream, Tracer, Array as Arr, Record as Rec } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import * as VendorFake from "@maple/backend/testing/vendor-fake"
import * as VendorHttp from "./vendor-http"

class AcmeError extends Schema.TaggedError<AcmeError>()("@maple/backend/test/AcmeError", {
	message: Schema.String,
	kind: Schema.String,
	status: Schema.optionalKey(Schema.Number),
	retryAfterSeconds: Schema.optionalKey(Schema.Number),
}) {}

const toError = (error: VendorHttp.VendorHttpError) =>
	new AcmeError({
		message: error.message,
		kind: error.kind,
		...(error.status === undefined ? undefined : { status: error.status }),
		...(error.retryAfterSeconds === undefined
			? undefined
			: { retryAfterSeconds: error.retryAfterSeconds }),
	})

const Item = Schema.Struct({ id: Schema.String })
const Page = Schema.Struct({ items: Schema.Array(Item), next: Schema.optionalKey(Schema.String) })

/** A client over `fake`, the way a vendor module builds one. */
const withClient = <A, E>(
	fake: VendorFake.VendorFake,
	use: (client: VendorHttp.VendorHttpClient<AcmeError>) => Effect.Effect<A, E>,
) =>
	Effect.gen(function* () {
		const httpClient = yield* HttpClient.HttpClient
		return yield* use(
			VendorHttp.make({
				httpClient,
				peerService: "acme",
				baseUrl: "https://api.acme.test",
				auth: VendorHttp.bearer("secret_token"),
				toError,
				timeout: "5 seconds",
				rateLimitResetHeader: "x-ratelimit-reset",
			}),
		)
	}).pipe(Effect.provide(Layer.merge(FetchHttpClient.layer, fake.layer)))

/** Answers with `replies` in turn, the last one for good. */
const sequence = (replies: ReadonlyArray<() => Response>) => {
	let served = 0
	return () => {
		const reply = replies[Math.min(served, replies.length - 1)]
		served++
		return reply?.()
	}
}

describe("VendorHttp", () => {
	it.effect("waits out a short retry-after on a 429 and sends the request again", () => {
		const fake = VendorFake.make({
			routes: [
				{
					path: "/v1/items",
					respond: sequence([
						() => VendorFake.json({ message: "slow down" }, 429, { "retry-after": "3" }),
						() => VendorFake.json({ items: [{ id: "a" }] }),
					]),
				},
			],
		})
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				const page = yield* VendorFake.elapsing(client.json(Page, { path: "/v1/items" }))
				assert.deepStrictEqual(page.items, [{ id: "a" }])
				assert.strictEqual(fake.calls.length, 2)
				assert.strictEqual(fake.calls[0]?.authorization, "Bearer secret_token")
			}),
		)
	})

	it.effect("fails a 429 with a long retry-after at once, carrying the wait", () => {
		const fake = VendorFake.make({
			routes: [
				{
					path: "/v1/items",
					respond: () =>
						VendorFake.json({ message: "slow down" }, 429, { "x-ratelimit-reset": "60" }),
				},
			],
		})
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(client.json(Page, { path: "/v1/items" }))
				assert.deepStrictEqual(
					[error.kind, error.status, error.retryAfterSeconds],
					["rate_limited", 429, 60],
				)
				assert.strictEqual(fake.calls.length, 1)
			}),
		)
	})

	it.effect("retries a 5xx and succeeds once the vendor recovers", () => {
		const fake = VendorFake.make({
			routes: [
				{
					path: "/v1/items",
					respond: sequence([
						() => VendorFake.json({ message: "bad gateway" }, 502),
						() => VendorFake.json({ message: "unavailable" }, 503),
						() => VendorFake.json({ items: [{ id: "b" }] }),
					]),
				},
			],
		})
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				const page = yield* VendorFake.elapsing(client.json(Page, { path: "/v1/items" }))
				assert.deepStrictEqual(page.items, [{ id: "b" }])
				assert.strictEqual(fake.calls.length, 3)
			}),
		)
	})

	it.effect("does not retry a POST that failed with a 5xx", () => {
		const fake = VendorFake.make({
			routes: [{ method: "POST", path: "/v1/items", respond: () => VendorFake.json({}, 500) }],
		})
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(
					client.json(Item, { method: "POST", path: "/v1/items", body: { id: "c" } }),
				)
				assert.deepStrictEqual([error.kind, error.status], ["upstream", 500])
				assert.strictEqual(fake.calls.length, 1)
			}),
		)
	})

	it.effect("times out a request that never answers, after retrying it", () => {
		const fake = VendorFake.make({ routes: [{ path: "/v1/items", respond: VendorFake.hang }] })
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(
					VendorFake.elapsing(client.json(Page, { path: "/v1/items", operation: "listing items" })),
				)
				assert.strictEqual(error.kind, "timeout")
				assert.strictEqual(error.message, "acme timed out while listing items")
				assert.strictEqual(fake.calls.length, 3)
			}),
		)
	})

	it.effect("asks fetch not to follow a redirect and fails on the 3xx", () => {
		const fake = VendorFake.make({
			routes: [
				{
					path: "/v1/items",
					respond: () => VendorFake.text("", 302, { location: "https://elsewhere.test/steal" }),
				},
			],
		})
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(client.json(Page, { path: "/v1/items" }))
				assert.deepStrictEqual([error.kind, error.status], ["upstream", 302])
				assert.deepStrictEqual(
					Arr.map(fake.calls, (call) => [call.url.host, call.redirect]),
					[["api.acme.test", "manual"]],
				)
			}),
		)
	})

	it.effect("classifies refusals, with a client's own override", () => {
		const statuses = [401, 403, 404, 410, 400]
		const fake = VendorFake.make({
			routes: [
				{
					respond: (request) => VendorFake.json({}, Number(request.search.get("status"))),
				},
			],
		})
		return withClient(fake, (client) =>
			Effect.forEach(statuses, (status) =>
				Effect.flip(client.text({ path: "/v1/x", query: { status: String(status) } })).pipe(
					Effect.map((error) => error.kind),
				),
			).pipe(
				Effect.map((kinds) =>
					assert.deepStrictEqual(kinds, [
						"unauthorized",
						"forbidden",
						"not_found",
						"not_found",
						"upstream",
					]),
				),
			),
		)
	})

	it.effect("fails a body that does not decode as invalid_response", () => {
		const fake = VendorFake.make({
			routes: [{ path: "/v1/items", respond: () => VendorFake.json({ items: "nope" }) }],
		})
		return withClient(fake, (client) =>
			Effect.flip(client.json(Page, { path: "/v1/items" })).pipe(
				Effect.map((error) => assert.strictEqual(error.kind, "invalid_response")),
			),
		)
	})

	it.effect("pages until the vendor has no next cursor, and stops at the cap", () => {
		const pages = new Map([
			["", { items: [{ id: "1" }], next: "p2" }],
			["p2", { items: [{ id: "2" }], next: "p3" }],
			["p3", { items: [{ id: "3" }] }],
		])
		const fake = VendorFake.make({
			routes: [
				{
					path: "/v1/items",
					respond: (request) => VendorFake.json(pages.get(request.search.get("cursor") ?? "")),
				},
			],
		})
		const paging = (maxPages: number) => ({
			schema: Page,
			maxPages,
			request: (cursor: Option.Option<string>) => ({
				path: "/v1/items",
				query: { limit: "1", cursor: Option.getOrUndefined(cursor) },
			}),
			next: (page: typeof Page.Type) => Option.fromUndefinedOr(page.next),
		})
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				const all = yield* client.paginate(paging(10))
				assert.deepStrictEqual(
					Arr.flatMap(all.pages, (page) => Arr.map(page.items, (item) => item.id)),
					["1", "2", "3"],
				)
				assert.isTrue(all.complete)
				assert.deepStrictEqual(
					Arr.map(fake.calls, (call) => call.url.search),
					["?limit=1", "?limit=1&cursor=p2", "?limit=1&cursor=p3"],
				)
				const capped = yield* client.paginate(paging(2))
				assert.deepStrictEqual([capped.pages.length, capped.complete], [2, false])
			}),
		)
	})

	it.effect("streams a 2xx body and reads a missing body as empty", () => {
		const fake = VendorFake.make({
			routes: [
				{ path: "/v1/lines", respond: () => VendorFake.text("a\nb\n") },
				{ path: "/v1/none", respond: () => VendorFake.empty(200) },
			],
		})
		const lines = (client: VendorHttp.VendorHttpClient<AcmeError>, path: string) =>
			client
				.stream({ path })
				.pipe(
					Effect.flatMap(({ body }) =>
						body.pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect),
					),
				)
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* lines(client, "/v1/lines"), ["a", "b"])
				assert.deepStrictEqual(yield* lines(client, "/v1/none"), [])
			}),
		)
	})

	it.effect("records one Client span per attempt with the path, never the query or token", () => {
		const spans: Array<Tracer.NativeSpan> = []
		const tracer = Tracer.make({
			span(options) {
				const span = new Tracer.NativeSpan(options)
				spans.push(span)
				return span
			},
		})
		const fake = VendorFake.make({
			routes: [{ path: "/v1/items", respond: () => VendorFake.json({ items: [] }) }],
		})
		return withClient(fake, (client) =>
			client
				.json(Page, { path: "/v1/items", query: { api_key: "leaky" }, operation: "listing items" })
				.pipe(Effect.withTracer(tracer)),
		).pipe(
			Effect.map(() => {
				assert.deepStrictEqual(
					Arr.map(spans, (span) => [span.name, span.kind]),
					[["VendorHttp.request", "client"]],
				)
				const attributes = Rec.fromEntries([...(spans[0]?.attributes ?? [])])
				assert.deepStrictEqual(attributes, {
					"peer.service": "acme",
					"http.request.method": "GET",
					"server.address": "api.acme.test",
					"url.scheme": "https",
					"url.path": "/v1/items",
					"maple.vendor.operation": "listing items",
					"http.response.status_code": 200,
				})
				assert.notInclude(JSON.stringify(attributes), "leaky")
				assert.notInclude(JSON.stringify(attributes), "secret_token")
			}),
		)
	})
})
