import { IntegrationReturnPath, MapleInternalApi } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { describe, expect, test } from "vitest"
import { MapleApiV2Client, MapleInternalApiClient } from "../../platform/api-clients"
import { ResourcesLive } from "../../platform/resources"
import { ConnectProvider, IntegrationCallbackEvents, startConnect } from "./connect"
import { subscriptions } from "./subscription"

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

describe("GitHub connect request", () => {
	test.each(["install", "existing"])("the %s action reaches the authorization endpoint", async (mode) => {
		await Effect.gen(function* () {
			const sent = yield* Ref.make<ReadonlyArray<unknown>>([])
			const http = HttpClient.make((request) =>
				Ref.update(sent, (requests) => [
					...requests,
					{
						method: request.method,
						url: request.url,
						body:
							request.body._tag === "Uint8Array"
								? decodeJson(request.body.text ?? new TextDecoder().decode(request.body.body))
								: request.body._tag,
					},
				]).pipe(
					Effect.as(
						HttpClientResponse.fromWeb(
							request,
							Response.json({ redirectUrl: "https://github.test/connect", state: "nonce" }),
						),
					),
				),
			)
			const clients = Layer.mergeAll(
				Layer.effect(
					MapleInternalApiClient,
					HttpApiClient.make(MapleInternalApi, { baseUrl: "https://api.test" }),
				),
				Layer.effect(
					MapleApiV2Client,
					HttpApiClient.make(MapleApiV2, { baseUrl: "https://api.test" }),
				),
			).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))
			const returnTo = IntegrationReturnPath.make("/sources/new?integration=github")
			const response = yield* startConnect(
				"github",
				returnTo,
				mode === "existing" ? "existing" : undefined,
			).pipe(Effect.provide(clients))
			expect(response.redirectUrl).toBe("https://github.test/connect")
			expect(yield* Ref.get(sent)).toEqual([
				{
					method: "POST",
					url: "https://api.test/internal/integrations/github/start",
					body: mode === "existing" ? { returnTo, mode: "existing" } : { returnTo },
				},
			])
		}).pipe(Effect.runPromise)
	})
})

describe("integration callback channel", () => {
	test.each(["github", "cloudflare"])(
		"a normal %s callback reaches update without an installation selection",
		async (rawProvider) => {
			const provider = Schema.decodeUnknownSync(ConnectProvider)(rawProvider)
			const message = new MessageEvent("message", {
				origin: "https://app.maple.dev",
				data: { type: `maple:integration:${provider}`, status: "success", message: "Connected" },
			})
			const received = await subscriptions.connectCallback.dependenciesToStream({ provider }).pipe(
				Stream.take(1),
				Stream.runCollect,
				Effect.provide(ResourcesLive),
				Effect.provideService(IntegrationCallbackEvents, {
					ownOrigin: "https://app.maple.dev",
					messages: Stream.make(message),
				}),
				Effect.runPromise,
			)
			expect(received).toEqual([
				{ _tag: "ReceivedConnectMessage", provider, status: "success", message: "Connected" },
			])
		},
	)
})
