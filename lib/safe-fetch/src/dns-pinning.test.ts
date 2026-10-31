import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import {
	DialServerName,
	guardPinned,
	HostResolutionError,
	UrlValidationError,
	type ResolveHost,
} from "./index"

interface Seen {
	readonly url: string
	readonly host: string | undefined
	readonly serverName: string | undefined
}

/** A fake DNS: `records[hostname]` or a resolution failure. */
const resolverOf =
	(records: Record<string, ReadonlyArray<string>>, asked: Array<string> = []): ResolveHost =>
	(hostname) => {
		asked.push(hostname)
		const addresses = records[hostname]
		return addresses === undefined
			? Effect.fail(new HostResolutionError({ message: `no record for ${hostname}`, hostname }))
			: Effect.succeed(addresses)
	}

const serverNameOf = (init: RequestInit | undefined): string | undefined => {
	const tls = init !== undefined && "tls" in init ? init.tls : undefined
	return typeof tls === "object" &&
		tls !== null &&
		"serverName" in tls &&
		typeof tls.serverName === "string"
		? tls.serverName
		: undefined
}

const hostHeaderOf = (init: RequestInit | undefined): string | undefined =>
	new Headers(init?.headers).get("host") ?? undefined

/** A pinned client over `fakeFetch`, recording what each hop actually dialled. */
const run = (
	resolve: ResolveHost,
	url: string,
	respond: (seen: ReadonlyArray<Seen>) => Response = () => new Response("ok"),
) => {
	const seen: Array<Seen> = []
	const fakeFetch: typeof fetch = async (input, init) => {
		seen.push({ url: String(input), host: hostHeaderOf(init), serverName: serverNameOf(init) })
		return respond(seen)
	}
	return Effect.flatMap(HttpClient.HttpClient, (client) => guardPinned(client, resolve).get(url)).pipe(
		Effect.provide(FetchHttpClient.layer),
		Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
		Effect.map((response) => ({ response, seen })),
		Effect.mapError((error) => ({ error, seen })),
	)
}

describe("guardPinned", () => {
	it.effect("rejects a public-looking hostname that resolves to a private address", () =>
		Effect.gen(function* () {
			const failure = yield* Effect.flip(
				run(resolverOf({ "rebind.example.com": ["10.0.0.5"] }), "https://rebind.example.com/x"),
			)
			assert.instanceOf(failure.error, UrlValidationError)
			assert.strictEqual(failure.seen.length, 0)
		}),
	)

	it.effect("rejects when any resolved address is private", () =>
		Effect.gen(function* () {
			const failure = yield* Effect.flip(
				run(
					resolverOf({ "mixed.example.com": ["93.184.216.34", "169.254.169.254"] }),
					"https://mixed.example.com/x",
				),
			)
			assert.instanceOf(failure.error, UrlValidationError)
		}),
	)

	it.effect("rejects private IPv6 answers", () =>
		Effect.gen(function* () {
			const failure = yield* Effect.flip(
				run(resolverOf({ "v6.example.com": ["fd00:ec2::254"] }), "https://v6.example.com/x"),
			)
			assert.instanceOf(failure.error, UrlValidationError)
		}),
	)

	it.effect("connects to the validated address, keeping the name for Host and TLS", () =>
		Effect.gen(function* () {
			const { response, seen } = yield* run(
				resolverOf({ "api.example.com": ["93.184.216.34"] }),
				"https://api.example.com:8443/metrics?sig=s",
			)
			assert.strictEqual(response.status, 200)
			assert.deepStrictEqual(seen, [
				{
					url: "https://93.184.216.34:8443/metrics?sig=s",
					host: "api.example.com:8443",
					serverName: "api.example.com",
				},
			])
		}),
	)

	it.effect("prefers an IPv4 answer when the lookup lists IPv6 first", () =>
		Effect.gen(function* () {
			const { seen } = yield* run(
				resolverOf({ "dual.example.com": ["2606:2800:220:1::1", "93.184.216.34"] }),
				"https://dual.example.com/x",
			)
			assert.strictEqual(seen[0]?.url, "https://93.184.216.34/x")
		}),
	)

	it.effect("brackets a pinned IPv6 address", () =>
		Effect.gen(function* () {
			const { seen } = yield* run(
				resolverOf({ "v6.example.com": ["2606:2800:220:1::1"] }),
				"https://v6.example.com/x",
			)
			assert.strictEqual(seen[0]?.url, "https://[2606:2800:220:1::1]/x")
		}),
	)

	it.effect("re-resolves and rejects a redirect to a name that resolves privately", () =>
		Effect.gen(function* () {
			const failure = yield* Effect.flip(
				run(
					resolverOf({ "api.example.com": ["93.184.216.34"], "next.example.com": ["127.0.0.1"] }),
					"https://api.example.com/x",
					() =>
						new Response(null, {
							status: 302,
							headers: { location: "https://next.example.com/y" },
						}),
				),
			)
			assert.instanceOf(failure.error, UrlValidationError)
			assert.strictEqual(failure.seen.length, 1)
		}),
	)

	it.effect("does not resolve a public IP literal", () =>
		Effect.gen(function* () {
			const asked: Array<string> = []
			const { seen } = yield* run(resolverOf({}, asked), "http://93.184.216.34/metrics")
			assert.deepStrictEqual(asked, [])
			assert.strictEqual(seen[0]?.url, "http://93.184.216.34/metrics")
		}),
	)

	it.effect("surfaces a resolution failure without fetching", () =>
		Effect.gen(function* () {
			const failure = yield* Effect.flip(run(resolverOf({}), "https://gone.example.com/x"))
			assert.instanceOf(failure.error, HostResolutionError)
			assert.strictEqual(failure.seen.length, 0)
		}),
	)

	it.effect(
		"hands a non-fetch transport the TLS name of a pinned hop, and none for a literal address",
		() =>
			Effect.gen(function* () {
				const dialled = yield* Ref.make<ReadonlyArray<readonly [string, string | null]>>([])
				const transport = HttpClient.make((request, url, _signal, fiber) =>
					Effect.as(
						Ref.update(dialled, (all) => [
							...all,
							[url.hostname, fiber.getRef(DialServerName)] as const,
						]),
						HttpClientResponse.fromWeb(request, new Response("ok")),
					),
				)
				const client = guardPinned(transport, resolverOf({ "api.example.com": ["93.184.216.34"] }))
				yield* Effect.scoped(client.get("https://api.example.com/x"))
				yield* Effect.scoped(client.get("https://93.184.216.35/x"))
				assert.deepStrictEqual(yield* Ref.get(dialled), [
					["93.184.216.34", "api.example.com"],
					["93.184.216.35", null],
				])
			}),
	)
})
