import { assert, describe, it } from "@effect/vitest"
import { EdgeCacheService } from "@maple/cache"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http"
import { CacheBackendLive } from "@maple/backend/platform/CacheBackendLive"
import { RuntimeAdvisoryCatalog } from "./RuntimeAdvisoryCatalog"

// Trimmed from OSV's answer for Bitnami `node` 20.10.0.
const NODE_BODY = {
	vulns: [
		{
			id: "BIT-node-2023-46809",
			aliases: ["BIT-node-min-2023-46809", "CVE-2023-46809"],
			details:
				"Node.js versions which bundle an unpatched version of OpenSSL are susceptible to a Marvin Attack. A second sentence.",
			published: "2024-03-06T10:56:52.360Z",
			database_specific: { severity: "Medium", cpes: ["cpe:2.3:a:nodejs:node.js:*"] },
			affected: [
				{
					package: { name: "node", ecosystem: "Bitnami" },
					ranges: [
						{
							type: "SEMVER",
							events: [
								{ introduced: "0" },
								{ fixed: "18.19.1" },
								{ introduced: "19.0.0" },
								{ fixed: "20.11.1" },
							],
						},
					],
				},
			],
		},
		{
			id: "BIT-node-2024-27983",
			aliases: ["CVE-2024-27983"],
			summary: "HTTP/2 server crash from a race in nghttp2",
			published: "2024-04-04T00:00:00.000Z",
			database_specific: { severity: "Critical" },
			affected: [
				{ ranges: [{ type: "SEMVER", events: [{ introduced: "20.0.0" }, { fixed: "20.12.1" }] }] },
			],
		},
	],
}

/** Answers Node.js, fails Python with a 503, and records each queried package and version. */
const osv = (requests: Array<string>) =>
	HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
		Effect.sync(() => {
			const body =
				request.body._tag === "Uint8Array"
					? JSON.parse(new TextDecoder().decode(request.body.body))
					: {}
			requests.push(`${body.package?.name}@${body.version}`)
			const response =
				body.package?.name === "node"
					? new Response(JSON.stringify(NODE_BODY), { status: 200 })
					: new Response("unavailable", { status: 503 })
			return HttpClientResponse.fromWeb(request, response)
		}),
	)

const catalogWith = (requests: Array<string>) =>
	Layer.effect(RuntimeAdvisoryCatalog, RuntimeAdvisoryCatalog.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(HttpClient.HttpClient, osv(requests)),
				EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive)),
			),
		),
	)

describe("RuntimeAdvisoryCatalog", () => {
	it.effect("returns each version's advisories worst first and leaves out one whose read failed", () => {
		const requests: Array<string> = []
		return Effect.gen(function* () {
			const catalog = yield* RuntimeAdvisoryCatalog
			const advisories = yield* catalog.advisories([
				{ product: "nodejs", version: "20.10.0" },
				{ product: "python", version: "3.12.7" },
				{ product: "nodejs", version: "20.10.0" },
				// Deno has no OSV package, so it is never asked for.
				{ product: "deno", version: "2.1.0" },
			])
			assert.deepStrictEqual(advisories.skipped, [])
			assert.deepStrictEqual(advisories.advisories, {
				"nodejs@20.10.0": [
					{
						id: "CVE-2024-27983",
						osvId: "BIT-node-2024-27983",
						summary: "HTTP/2 server crash from a race in nghttp2",
						severity: "critical",
						fixedIn: "20.12.1",
						published: "2024-04-04T00:00:00.000Z",
					},
					{
						id: "CVE-2023-46809",
						osvId: "BIT-node-2023-46809",
						summary:
							"Node.js versions which bundle an unpatched version of OpenSSL are susceptible to a Marvin Attack.",
						severity: "medium",
						fixedIn: "20.11.1",
						published: "2024-03-06T10:56:52.360Z",
					},
				],
			})
			assert.deepStrictEqual(requests.toSorted(), ["node@20.10.0", "python@3.12.7"])
		}).pipe(Effect.provide(catalogWith(requests)))
	})

	it.effect("serves a repeat read from the cache", () => {
		const requests: Array<string> = []
		return Effect.gen(function* () {
			const catalog = yield* RuntimeAdvisoryCatalog
			yield* catalog.advisories([{ product: "nodejs", version: "20.10.0" }])
			const again = yield* catalog.advisories([{ product: "nodejs", version: "20.10.0" }])
			assert.strictEqual(again.advisories["nodejs@20.10.0"]?.length, 2)
			assert.deepStrictEqual(requests, ["node@20.10.0"])
		}).pipe(Effect.provide(catalogWith(requests)))
	})

	it.effect("reads at most 24 uncached versions a request and serves cached ones past that", () => {
		const requests: Array<string> = []
		const targets = Array.from({ length: 26 }, (_, index) => ({
			product: "nodejs" as const,
			version: `20.${index}.0`,
		}))
		return Effect.gen(function* () {
			const catalog = yield* RuntimeAdvisoryCatalog
			const first = yield* catalog.advisories(targets)
			assert.strictEqual(Object.keys(first.advisories).length, 24)
			assert.strictEqual(first.skipped.length, 2)
			assert.strictEqual(requests.length, 24)
			// The 24 now cached cost nothing, so the next request reads the two it skipped.
			const second = yield* catalog.advisories(targets)
			assert.strictEqual(Object.keys(second.advisories).length, 26)
			assert.deepStrictEqual(second.skipped, [])
			assert.strictEqual(requests.length, 26)
		}).pipe(Effect.provide(catalogWith(requests)))
	})
})
