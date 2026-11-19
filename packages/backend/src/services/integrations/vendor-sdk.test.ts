import * as Vercel from "@distilled.cloud/vercel"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Schema, Tracer, Array as Arr, Record as Rec, String as Str } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import * as VendorFake from "@maple/backend/testing/vendor-fake"
import type * as VendorHttp from "./vendor-http"
import * as VendorSdk from "./vendor-sdk"

const BASE_URL = "https://api.acme.test"
const Drains = Schema.Struct({ drains: Schema.Array(Schema.Struct({ id: Schema.String })) })
const Drain = Schema.Struct({ id: Schema.String })

/** A client over `fake` with a real SDK, its own retries off, as a vendor module builds one. */
const withClient = <A, E>(
	fake: VendorFake.VendorFake,
	use: (client: ReturnType<typeof make>) => Effect.Effect<A, E>,
	rateLimitResetHeader?: string,
) =>
	Effect.gen(function* () {
		return yield* use(make(yield* HttpClient.HttpClient, rateLimitResetHeader))
	}).pipe(Effect.provide(Layer.merge(FetchHttpClient.layer, fake.layer)))

const make = (httpClient: HttpClient.HttpClient, rateLimitResetHeader?: string) =>
	VendorSdk.make({
		...(rateLimitResetHeader === undefined ? undefined : { rateLimitResetHeader }),
		httpClient,
		peerService: "acme",
		sdk: Layer.mergeAll(
			Vercel.credentials({ token: Redacted.make("secret_token"), apiBaseUrl: BASE_URL }),
			Layer.succeed(Vercel.Retry.Retry, { while: () => false }),
		),
		statusByTag: { Forbidden: 403, TooManyRequests: 429, BadGateway: 502, GatewayTimeout: 504 },
		toError: (error: VendorHttp.VendorHttpError) => error,
		timeout: "5 seconds",
	})

const listDrains = (client: ReturnType<typeof make>) =>
	client.call(Drains, Vercel.drains.getDrains({ teamId: "team_1" }), { operation: "listing drains" })

const createDrain = (client: ReturnType<typeof make>) =>
	client.call(
		Drain,
		Vercel.drains.createDrain({
			teamId: "team_1",
			name: "maple",
			projects: "all",
			schemas: { log: { version: "v1" } },
			delivery: { type: "http", endpoint: "https://in.test", encoding: "json", headers: {} },
		}),
		{ method: "POST" },
	)

const drainsRoute = (respond: VendorFake.VendorFakeRoute["respond"]): VendorFake.VendorFakeRoute => ({
	path: "/v1/drains",
	respond,
})

describe("VendorSdk", () => {
	it.effect("retries a read that met an upstream outage, and keeps the last status", () => {
		const fake = VendorFake.make({ routes: [drainsRoute(() => VendorFake.json({ error: {} }, 502))] })
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(VendorFake.elapsing(listDrains(client)))
				assert.deepStrictEqual([error.kind, error.status], ["upstream", 502])
				assert.strictEqual(fake.calls.length, 3)
			}),
		)
	})

	it.effect("sends a create once, whatever the outage", () => {
		const fake = VendorFake.make({ routes: [drainsRoute(() => VendorFake.json({ error: {} }, 502))] })
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(VendorFake.elapsing(createDrain(client)))
				assert.deepStrictEqual([error.kind, error.status], ["upstream", 502])
				assert.strictEqual(fake.calls.length, 1)
			}),
		)
	})

	it.effect("refuses a redirect with its status instead of reading its body as the answer", () => {
		const fake = VendorFake.make({
			routes: [
				drainsRoute(() =>
					VendorFake.json({ drains: [] }, 302, { location: "https://elsewhere.test/" }),
				),
			],
		})
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(createDrain(client))
				assert.deepStrictEqual(
					[error.kind, error.status, error.location],
					["upstream", 302, "https://elsewhere.test/"],
				)
				assert.deepStrictEqual(
					Arr.map(fake.calls, (call) => call.redirect),
					["manual"],
				)
			}),
		)
	})

	it.effect("records one Client span per attempt with the path, and none of the SDK's", () => {
		const spans: Array<Tracer.NativeSpan> = []
		const tracer = Tracer.make({
			span(options) {
				const span = new Tracer.NativeSpan(options)
				spans.push(span)
				return span
			},
		})
		const fake = VendorFake.make({
			routes: [
				drainsRoute(() => VendorFake.json({ error: { message: "Drains need a Pro plan" } }, 403)),
			],
		})
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				yield* Effect.flip(listDrains(client))
				assert.deepStrictEqual(
					Arr.map(spans, (span) => [
						span.name,
						span.kind,
						span.status._tag === "Ended" ? span.status.exit._tag : "Open",
					]),
					[["VendorSdk.request", "client", "Success"]],
				)
				const attributes = Rec.fromEntries([...(spans[0]?.attributes ?? [])])
				assert.deepStrictEqual(
					[
						attributes["peer.service"],
						attributes["server.address"],
						attributes["url.path"],
						attributes["http.request.method"],
						attributes["http.response.status_code"],
						attributes["error.type"],
					],
					["acme", "api.acme.test", "/v1/drains", "GET", 403, "forbidden"],
				)
				// Neither the query nor the vendor's message reaches the span.
				assert.isFalse(Str.includes("team_1")(JSON.stringify(attributes)))
				assert.isFalse(Str.includes("Pro plan")(JSON.stringify(attributes)))
			}).pipe(Effect.withTracer(tracer)),
		)
	})

	it.effect("keeps the vendor's message on a refusal, as the kit's `detail`", () => {
		const fake = VendorFake.make({
			routes: [
				drainsRoute(() => VendorFake.json({ error: { message: "Drains need a Pro plan" } }, 403)),
			],
		})
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(listDrains(client))
				assert.deepStrictEqual(
					[error.kind, error.status, error.detail],
					["forbidden", 403, "Drains need a Pro plan"],
				)
				assert.strictEqual(fake.calls[0]?.authorization, "Bearer secret_token")
			}),
		)
	})

	it.effect("waits out a short retry-after on a 429, even for a create, and sends it again", () => {
		let served = 0
		const fake = VendorFake.make({
			routes: [
				drainsRoute(() =>
					served++ === 0
						? VendorFake.json({ error: { message: "slow down" } }, 429, { "retry-after": "3" })
						: VendorFake.json({ id: "drn_1" }),
				),
			],
		})
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				const drain = yield* VendorFake.elapsing(createDrain(client))
				assert.strictEqual(drain.id, "drn_1")
				assert.strictEqual(fake.calls.length, 2)
			}),
		)
	})

	it.effect("fails a long retry-after at once as rate limited, with the wait", () => {
		const fake = VendorFake.make({
			routes: [drainsRoute(() => VendorFake.json({ error: {} }, 429, { "retry-after": "1800" }))],
		})
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(listDrains(client))
				assert.deepStrictEqual([error.kind, error.retryAfterSeconds], ["rate_limited", 1800])
				assert.strictEqual(fake.calls.length, 1)
			}),
		)
	})

	it.effect("reads an empty or null 2xx body as no answer, not as an empty listing", () => {
		// A listing whose fields are all optional: `{}` is a real empty page, nothing at all is not.
		const Listing = Schema.Struct({ drains: Schema.optionalKey(Schema.Array(Drain)) })
		const replies = [VendorFake.text(""), VendorFake.text("null"), VendorFake.json({})]
		const fake = VendorFake.make({
			routes: [drainsRoute(() => replies.shift() ?? VendorFake.json({}))],
		})
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				const list = client.call(Listing, Vercel.drains.getDrains({ teamId: "team_1" }), {
					retry: false,
				})
				assert.strictEqual((yield* Effect.flip(list)).kind, "invalid_response")
				assert.strictEqual((yield* Effect.flip(list)).kind, "invalid_response")
				assert.deepStrictEqual(yield* list, {})
			}),
		)
	})

	it.effect("reports the status the vendor sent where the SDK's error class stands for two", () => {
		const fake = VendorFake.make({ routes: [drainsRoute(() => VendorFake.json({ error: {} }, 408))] })
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(createDrain(client))
				assert.deepStrictEqual([error.kind, error.status], ["upstream", 408])
			}),
		)
	})

	it.effect("reads the wait of a 429 from the vendor's own reset header", () => {
		const fake = VendorFake.make({
			routes: [drainsRoute(() => VendorFake.json({ error: {} }, 429, { "x-ratelimit-reset": "120" }))],
		})
		return withClient(
			fake,
			(client) =>
				Effect.gen(function* () {
					const error = yield* Effect.flip(listDrains(client))
					assert.deepStrictEqual([error.kind, error.retryAfterSeconds], ["rate_limited", 120])
				}),
			"x-ratelimit-reset",
		)
	})

	it.effect("keeps no message from a refusal whose body had none", () => {
		const fake = VendorFake.make({ routes: [drainsRoute(() => VendorFake.text("", 403))] })
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(listDrains(client))
				assert.deepStrictEqual([error.kind, error.detail], ["forbidden", undefined])
			}),
		)
	})

	it.effect("fails a 2xx body Maple cannot read as an invalid response", () => {
		const fake = VendorFake.make({ routes: [drainsRoute(() => VendorFake.json({ drains: "none" }))] })
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				assert.strictEqual((yield* Effect.flip(listDrains(client))).kind, "invalid_response")
			}),
		)
	})

	it.effect("times out an attempt that never answers", () => {
		const fake = VendorFake.make({ routes: [drainsRoute(VendorFake.hang)] })
		return withClient(fake, (client) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(VendorFake.elapsing(listDrains(client)))
				assert.strictEqual(error.kind, "timeout")
				assert.strictEqual(error.message, "acme timed out while listing drains")
			}),
		)
	})
})
