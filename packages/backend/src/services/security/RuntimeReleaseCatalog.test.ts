import { assert, describe, it } from "@effect/vitest"
import { EdgeCacheService } from "@maple/cache"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http"
import { CacheBackendLive } from "@maple/backend/platform/CacheBackendLive"
import { RuntimeReleaseCatalog } from "./RuntimeReleaseCatalog"

const NODE_BODY = {
	result: {
		releases: [
			{ name: "22", isEol: false, eolFrom: "2027-04-30", latest: { name: "22.21.1" } },
			{ name: "18", isEol: true, eolFrom: "2025-04-30", latest: { name: "18.20.8" } },
			{ name: "0.10", isEol: null, eolFrom: null, latest: null },
		],
	},
}

/** Answers Node.js, fails Python with a 503, and counts the requests it served. */
const endoflife = (requests: Array<string>) =>
	HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
		Effect.sync(() => {
			requests.push(request.url)
			const response = request.url.endsWith("/nodejs")
				? new Response(JSON.stringify(NODE_BODY), { status: 200 })
				: new Response("unavailable", { status: 503 })
			return HttpClientResponse.fromWeb(request, response)
		}),
	)

const catalogWith = (requests: Array<string>) =>
	Layer.effect(RuntimeReleaseCatalog, RuntimeReleaseCatalog.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(HttpClient.HttpClient, endoflife(requests)),
				EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive)),
			),
		),
	)

describe("RuntimeReleaseCatalog", () => {
	it.effect("returns each runtime's cycles and leaves out one whose read failed", () => {
		const requests: Array<string> = []
		return Effect.gen(function* () {
			const catalog = yield* RuntimeReleaseCatalog
			const releases = yield* catalog.releases(["nodejs", "python", "nodejs"])
			assert.deepStrictEqual(releases, {
				nodejs: [
					{ cycle: "22", isEol: false, eolFrom: "2027-04-30", latest: "22.21.1" },
					{ cycle: "18", isEol: true, eolFrom: "2025-04-30", latest: "18.20.8" },
					{ cycle: "0.10", isEol: false, eolFrom: null, latest: null },
				],
			})
			// A runtime asked for twice is read once.
			assert.deepStrictEqual(requests.toSorted(), [
				"https://endoflife.date/api/v1/products/nodejs",
				"https://endoflife.date/api/v1/products/python",
			])
		}).pipe(Effect.provide(catalogWith(requests)))
	})

	it.effect("serves a repeat read from the cache", () => {
		const requests: Array<string> = []
		return Effect.gen(function* () {
			const catalog = yield* RuntimeReleaseCatalog
			yield* catalog.releases(["nodejs"])
			const again = yield* catalog.releases(["nodejs"])
			assert.strictEqual(again.nodejs?.length, 3)
			assert.deepStrictEqual(requests, ["https://endoflife.date/api/v1/products/nodejs"])
		}).pipe(Effect.provide(catalogWith(requests)))
	})
})
