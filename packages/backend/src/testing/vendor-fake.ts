/**
 * A fake vendor API for tests: requests are matched against `routes` in order and every one is
 * recorded. Provide it with `layer` (it replaces `FetchHttpClient.Fetch`). A route answering
 * `undefined` passes the request to the next route; nothing matching answers 404.
 */
import { Effect, Fiber, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"

export interface VendorFakeRequest {
	readonly method: string
	readonly url: URL
	readonly path: string
	readonly search: URLSearchParams
	readonly headers: Headers
	readonly authorization: string | null
	readonly body: string
	/** The fetch `redirect` mode the client asked for. */
	readonly redirect: RequestRedirect | undefined
	readonly signal: AbortSignal | undefined
}

export type VendorFakeReply = Response | undefined

export interface VendorFakeRoute {
	readonly method?: string
	/** A path, matched whole, or a pattern tested against it. */
	readonly path?: string | RegExp
	readonly respond: (request: VendorFakeRequest) => VendorFakeReply | Promise<VendorFakeReply>
}

export interface VendorFake {
	readonly calls: Array<VendorFakeRequest>
	readonly fetch: typeof globalThis.fetch
	readonly layer: Layer.Layer<never>
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

export const json = (body: unknown, status = 200, headers: Readonly<Record<string, string>> = {}) =>
	new Response(encodeJson(body), { status, headers: { "content-type": "application/json", ...headers } })

export const text = (body: string | null, status = 200, headers: Readonly<Record<string, string>> = {}) =>
	new Response(body, { status, headers })

export const empty = (status = 204) => new Response(null, { status })

/** Never answers; rejects once the client gives up, as a hung connection does. */
export const hang = (request: VendorFakeRequest): Promise<Response> =>
	new Promise((_, reject) =>
		request.signal?.addEventListener("abort", () => reject(request.signal?.reason)),
	)

const matches = (route: VendorFakeRoute, request: VendorFakeRequest) =>
	(route.method === undefined || route.method === request.method) &&
	(route.path === undefined ||
		(typeof route.path === "string" ? route.path === request.path : route.path.test(request.path)))

const answer = async (
	routes: ReadonlyArray<VendorFakeRoute>,
	request: VendorFakeRequest,
	index: number,
): Promise<Response> => {
	const route = routes[index]
	if (route === undefined) return json({ message: "Not found" }, 404)
	const reply = matches(route, request) ? await route.respond(request) : undefined
	return reply ?? answer(routes, request, index + 1)
}

export const make = (options: { readonly routes: ReadonlyArray<VendorFakeRoute> }): VendorFake => {
	const calls: Array<VendorFakeRequest> = []
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const requestInit: RequestInit & { readonly duplex: "half" } = { ...init, duplex: "half" }
		const incoming = new Request(input, requestInit)
		const url = new URL(incoming.url)
		const request: VendorFakeRequest = {
			method: incoming.method,
			url,
			path: url.pathname,
			search: url.searchParams,
			headers: incoming.headers,
			authorization: incoming.headers.get("authorization"),
			body: await incoming.text(),
			redirect: init?.redirect,
			signal: init?.signal ?? undefined,
		}
		calls.push(request)
		return answer(options.routes, request, 0)
	}
	return { calls, fetch, layer: Layer.succeed(FetchHttpClient.Fetch, fetch) }
}

/**
 * Runs `effect` while moving the test clock forward a second at a time, so retry back-offs and
 * `retry-after` waits elapse. The live pause lets a fake's promise settle between steps.
 */
export const elapsing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const fiber = yield* Effect.forkChild(effect)
		yield* TestClock.adjust("1 second").pipe(
			Effect.andThen(TestClock.withLive(Effect.sleep("2 millis"))),
			Effect.repeat({ until: () => fiber.pollUnsafe() !== undefined, times: 600 }),
		)
		return yield* Fiber.join(fiber)
	})
