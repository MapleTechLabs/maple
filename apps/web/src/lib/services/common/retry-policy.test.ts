import { Effect, Option, Ref } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import {
	isRetryableResponse,
	isRetryableTransportError,
	withMapleRetryPolicy,
	withUnauthorizedResign,
} from "./retry-policy"

const transportError = (request: HttpClientRequest.HttpClientRequest, cause?: unknown) =>
	new HttpClientError.HttpClientError({
		reason: new HttpClientError.TransportError({ request, cause }),
	})

describe("isRetryableTransportError", () => {
	it("retries transport failures on idempotent requests", () => {
		const error = transportError(HttpClientRequest.get("https://api.maple.dev/v1/services"))
		expect(isRetryableTransportError(error)).toBe(true)
	})

	it("never replays mutations", () => {
		const error = transportError(HttpClientRequest.post("https://api.maple.dev/v1/dashboards"))
		expect(isRetryableTransportError(error)).toBe(false)
	})

	it("does not multiply the client timeout", () => {
		const error = transportError(
			HttpClientRequest.get("https://api.maple.dev/v1/services"),
			new DOMException("timed out", "TimeoutError"),
		)
		expect(isRetryableTransportError(error)).toBe(false)
	})

	it("does not replay aborted requests", () => {
		const error = transportError(
			HttpClientRequest.get("https://api.maple.dev/v1/services"),
			new DOMException("aborted", "AbortError"),
		)
		expect(isRetryableTransportError(error)).toBe(false)
	})

	it("ignores non-HttpClientError values", () => {
		expect(isRetryableTransportError(new Error("Failed to fetch"))).toBe(false)
	})
})

describe("isRetryableResponse", () => {
	const response = (request: HttpClientRequest.HttpClientRequest, status: number) =>
		HttpClientResponse.fromWeb(request, new Response(null, { status }))

	it.each([500, 502, 503])("retries transient %s responses for reads", (status) => {
		expect(
			isRetryableResponse(response(HttpClientRequest.get("https://api.maple.dev/v1/services"), status)),
		).toBe(true)
	})

	it.each([400, 401, 408, 429, 504])("does not hide actionable %s responses", (status) => {
		expect(
			isRetryableResponse(response(HttpClientRequest.get("https://api.maple.dev/v1/services"), status)),
		).toBe(false)
	})

	it("never replays a mutation response", () => {
		expect(
			isRetryableResponse(response(HttpClientRequest.post("https://api.maple.dev/v1/dashboards"), 503)),
		).toBe(false)
	})

	it.each([500, 502, 503])("leaves v2 %s retry decisions to the decoded error body", (status) => {
		expect(
			isRetryableResponse(response(HttpClientRequest.get("https://api.maple.dev/v2/services"), status)),
		).toBe(false)
	})

	it.live("replays a raw transient response before API error decoding", () =>
		Effect.gen(function* () {
			let attempts = 0
			const client = withMapleRetryPolicy(
				HttpClient.make((request) =>
					Effect.sync(() => {
						attempts += 1
						return response(request, attempts === 1 ? 503 : 200)
					}),
				),
			)

			const result = yield* client.get("https://api.maple.dev/v1/services")
			expect(result.status).toBe(200)
			expect(attempts).toBe(2)
		}),
	)

	it.live("returns a mutation failure response without replaying it", () =>
		Effect.gen(function* () {
			let attempts = 0
			const client = withMapleRetryPolicy(
				HttpClient.make((request) =>
					Effect.sync(() => {
						attempts += 1
						return response(request, 503)
					}),
				),
			)

			const result = yield* client.post("https://api.maple.dev/v1/dashboards")
			expect(result.status).toBe(503)
			expect(attempts).toBe(1)
		}),
	)
})

describe("withUnauthorizedResign", () => {
	// Records each sent bearer; only `fresh` is accepted.
	const makeClient = (sent: Ref.Ref<ReadonlyArray<string | undefined>>, shouldRetry: boolean) =>
		withUnauthorizedResign(
			HttpClient.mapRequest(
				HttpClient.make((request) =>
					Ref.update(sent, (all) => [...all, request.headers.authorization]).pipe(
						Effect.as(
							HttpClientResponse.fromWeb(
								request,
								new Response(null, {
									status: request.headers.authorization === "Bearer fresh" ? 200 : 401,
								}),
							),
						),
					),
				),
				HttpClientRequest.bearerToken("stale"),
			),
			{ shouldRetry: () => shouldRetry, freshToken: Effect.succeed(Option.some("fresh")) },
		)

	it.live("resends a 401 read signed with a freshly fetched token", () =>
		Effect.gen(function* () {
			const sent = yield* Ref.make<ReadonlyArray<string | undefined>>([])
			const result = yield* makeClient(sent, true).get(
				"https://api.maple.dev/internal/billing/customer",
			)

			expect(result.status).toBe(200)
			expect(yield* Ref.get(sent)).toEqual(["Bearer stale", "Bearer fresh"])
		}),
	)

	it.live("fails fast on a 401 outside the retried scope", () =>
		Effect.gen(function* () {
			const sent = yield* Ref.make<ReadonlyArray<string | undefined>>([])
			const result = yield* makeClient(sent, false).get("https://api.maple.dev/v1/services")

			expect(result.status).toBe(401)
			expect(yield* Ref.get(sent)).toEqual(["Bearer stale"])
		}),
	)

	it.live("never replays a mutation", () =>
		Effect.gen(function* () {
			const sent = yield* Ref.make<ReadonlyArray<string | undefined>>([])
			const result = yield* makeClient(sent, true).post(
				"https://api.maple.dev/internal/billing/customer",
			)

			expect(result.status).toBe(401)
			expect(yield* Ref.get(sent)).toEqual(["Bearer stale"])
		}),
	)
})
