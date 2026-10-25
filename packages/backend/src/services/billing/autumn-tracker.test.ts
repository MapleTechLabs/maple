import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http"
import { trackSecurityAuditCharge } from "./autumn-tracker"

interface Captured {
	readonly url: string
	readonly idempotencyKey: string | undefined
	readonly body: unknown
}

const recordingClient = (captured: Array<Captured>) =>
	HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
		Effect.sync(() => {
			const text =
				request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}"
			captured.push({
				url: request.url,
				idempotencyKey: request.headers["idempotency-key"],
				body: JSON.parse(text),
			})
			return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))
		}),
	)

const withEnv = (env: Record<string, string>, captured: Array<Captured>) =>
	Layer.mergeAll(
		ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
		Layer.succeed(HttpClient.HttpClient, recordingClient(captured)),
	)

const BILLED = { AUTUMN_SECRET_KEY: "am_sk_test", MAPLE_DEFAULT_ORG_ID: "org_maple" }

describe("trackSecurityAuditCharge", () => {
	it.effect("charges dollars to AI credits, keyed by run, agent and kind", () =>
		Effect.gen(function* () {
			const captured: Array<Captured> = []
			yield* trackSecurityAuditCharge({
				orgId: "org_a",
				runId: "run-1",
				agentId: "hunter-w1-1",
				kind: "sandbox",
				usd: 0.02,
			}).pipe(Effect.provide(withEnv(BILLED, captured)))
			assert.deepStrictEqual(captured, [
				{
					url: "https://api.useautumn.com/v1/balances.track",
					idempotencyKey: "run-1:hunter-w1-1:security_audit:sandbox",
					body: {
						customer_id: "org_a",
						feature_id: "ai_credits",
						value: 0.02,
						idempotency_key: "run-1:hunter-w1-1:security_audit:sandbox",
						properties: {
							source: "security_audit",
							kind: "sandbox",
							run_id: "run-1",
							agent_id: "hunter-w1-1",
						},
					},
				},
			])
		}),
	)

	it.effect("charges nothing for Maple's own org, without a billing key, or for no cost", () =>
		Effect.gen(function* () {
			const captured: Array<Captured> = []
			const track = (orgId: string, usd: number) =>
				trackSecurityAuditCharge({ orgId, runId: "run-1", agentId: "recon-1", kind: "model", usd })
			yield* track("org_maple", 1).pipe(Effect.provide(withEnv(BILLED, captured)))
			yield* track("org_a", 1).pipe(Effect.provide(withEnv({}, captured)))
			yield* track("org_a", 0).pipe(Effect.provide(withEnv(BILLED, captured)))
			assert.deepStrictEqual(captured, [])
		}),
	)
})
