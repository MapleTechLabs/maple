import { describe, it } from "@effect/vitest"
import { MapleApiV2, V2OnboardingAgentHandoff } from "@maple/domain/http/v2"
import { Effect, Layer, Ref, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { expect } from "vitest"
import { labHandoff } from "../../lab/onboarding-agent-fixture"
import { MapleApiV2Client } from "../../platform/api-clients"
import { mintHandoff } from "./agent-handoff"

/** The v2 client on an API that answers every request with a minted handoff, counting them. */
const countingApi = Effect.gen(function* () {
	const requests = yield* Ref.make<ReadonlyArray<string>>([])
	const body = Schema.encodeSync(V2OnboardingAgentHandoff)(labHandoff())
	const http = HttpClient.make((request) =>
		Ref.update(requests, (seen) => [...seen, `${request.method} ${new URL(request.url).pathname}`]).pipe(
			Effect.as(HttpClientResponse.fromWeb(request, Response.json(body))),
		),
	)
	const client = Layer.effect(
		MapleApiV2Client,
		HttpApiClient.make(MapleApiV2, { baseUrl: "https://api.test" }),
	).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))
	return { requests, client }
})

describe("mintHandoff", () => {
	it.effect("a control org copies without a code and never starts a run", () =>
		Effect.gen(function* () {
			const { requests, client } = yield* countingApi
			const message = yield* mintHandoff("maple_pk_test", Effect.succeed("control")).pipe(
				Effect.provide(client),
			)
			expect(message._tag).toBe("SkippedMint")
			expect(yield* Ref.get(requests)).toEqual([])
		}),
	)

	it.effect("a handoff org starts a run and gets its code", () =>
		Effect.gen(function* () {
			const { requests, client } = yield* countingApi
			const message = yield* mintHandoff("maple_pk_test", Effect.succeed("handoff")).pipe(
				Effect.provide(client),
			)
			expect(message._tag).toBe("SucceededMint")
			expect(yield* Ref.get(requests)).toEqual(["POST /v2/onboarding/agent_run"])
		}),
	)
})
