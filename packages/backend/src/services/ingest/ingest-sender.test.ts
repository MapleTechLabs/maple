import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { isRefusal, makeIngestSender } from "./ingest-sender"

interface Sent {
	readonly url: string
	readonly authorization: string | null
	readonly body: unknown
}

const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		PORT: "3472",
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		MAPLE_INGEST_PUBLIC_URL: "https://ingest.test/",
	}),
)

/** A gateway that records each request and answers with `status` and `body`. */
const gateway =
	(sent: Array<Sent>, status: number, body = "{}"): typeof fetch =>
	async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
		sent.push({
			url,
			authorization: new Headers(init?.headers).get("authorization"),
			body: JSON.parse(await new Response(init?.body ?? null).text()),
		})
		return new Response(body, { status })
	}

const send = (fetch: typeof fetch) =>
	makeIngestSender.pipe(
		Effect.flatMap((ingest) =>
			ingest.send({
				signal: "metrics",
				ingestKey: "maple_pk_test",
				payload: { resourceMetrics: [] },
				label: "Test metrics",
			}),
		),
		Effect.provide(
			Layer.mergeAll(
				FetchHttpClient.layer,
				Layer.succeed(FetchHttpClient.Fetch, fetch),
				Env.layer.pipe(Layer.provide(config)),
			),
		),
	)

describe("makeIngestSender", () => {
	it.effect("posts the payload to the signal's OTLP path with the org's key", () => {
		const sent: Array<Sent> = []
		return Effect.gen(function* () {
			yield* send(gateway(sent, 200))
			assert.deepStrictEqual(sent, [
				{
					url: "https://ingest.test/v1/metrics",
					authorization: "Bearer maple_pk_test",
					body: { resourceMetrics: [] },
				},
			])
		})
	})

	it.effect("fails with the status and the gateway's reason, and tells a refused key apart", () => {
		const sent: Array<Sent> = []
		return Effect.gen(function* () {
			const refused = yield* Effect.flip(send(gateway(sent, 402, "over plan limit")))
			assert.deepStrictEqual(
				[refused.status, refused.message],
				[402, "Test metrics ingest returned 402: over plan limit"],
			)
			assert.isTrue(isRefusal(refused))

			const failed = yield* Effect.flip(send(gateway(sent, 503, "")))
			assert.deepStrictEqual([failed.status, isRefusal(failed)], [503, false])
		})
	})
})
