import { MapleInternalApi } from "@maple/domain/http"
import { Array as Arr, Effect, Layer, Ref, Result, String as Str } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { describe, expect, test } from "vitest"
import { ReadCache } from "../../data/read-cache"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { commitDetailKey, commitDetailsKey, loadCommitDetail, readCommitDetails } from "./commit-card"

const SHA_A = Str.repeat(40)("a")
const SHA_B = Str.repeat(40)("b")

const notConnected = {
	_tag: "@maple/http/errors/IntegrationsNotConnectedError",
	message: "GitHub is not connected",
}

/** A VCS API that answers every commit lookup with the 409 an org without GitHub gets. */
const disconnectedApi = Effect.gen(function* () {
	const sent = yield* Ref.make(0)
	const http = HttpClient.make((request) =>
		Ref.update(sent, (count) => count + 1).pipe(
			Effect.as(HttpClientResponse.fromWeb(request, Response.json(notConnected, { status: 409 }))),
		),
	)
	const layer = Layer.mergeAll(
		ReadCache.layer,
		Layer.effect(
			MapleInternalApiClient,
			HttpApiClient.make(MapleInternalApi, { baseUrl: "https://api.test" }),
		),
	).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))
	return { sent, layer }
})

describe("commit lookups for an org without a connected repository", () => {
	test("only the first hovered commit asks; later ones answer not connected from memory", async () => {
		await Effect.gen(function* () {
			const { sent, layer } = yield* disconnectedApi
			const [first, second] = yield* Effect.all(
				[
					loadCommitDetail(commitDetailKey("org_a", SHA_A), SHA_A),
					loadCommitDetail(commitDetailKey("org_a", SHA_B), SHA_B),
				],
				{ concurrency: 1 },
			).pipe(Effect.provide(layer))
			const tags = Arr.map([first, second], (result) =>
				Result.match(result, { onSuccess: () => "success", onFailure: (failure) => failure.tag }),
			)
			expect(tags).toEqual(Arr.replicate("@maple/http/errors/IntegrationsNotConnectedError", 2))
			expect(yield* Ref.get(sent)).toBe(1)
		}).pipe(Effect.scoped, Effect.runPromise)
	})

	test("the memo is per org, covers batched lookups, and a refresh still asks", async () => {
		await Effect.gen(function* () {
			const { sent, layer } = yield* disconnectedApi
			yield* Effect.gen(function* () {
				const batch = readCommitDetails(commitDetailsKey("org_a", SHA_A), SHA_A)
				yield* Effect.flip(batch)
				yield* Effect.flip(readCommitDetails(commitDetailsKey("org_a", SHA_B), SHA_B))
				expect(yield* Ref.get(sent)).toBe(1)
				yield* Effect.flip(readCommitDetails(commitDetailsKey("org_b", SHA_A), SHA_A))
				expect(yield* Ref.get(sent)).toBe(2)
				// Refresh asks again, so a repository connected meanwhile shows up.
				yield* Effect.flip(readCommitDetails(commitDetailsKey("org_a", SHA_B), SHA_B, true))
				expect(yield* Ref.get(sent)).toBe(3)
			}).pipe(Effect.provide(layer))
		}).pipe(Effect.scoped, Effect.runPromise)
	})
})
