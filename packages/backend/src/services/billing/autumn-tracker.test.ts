import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http"
import { trackSecurityAuditInvocations } from "./autumn-tracker"

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

describe("trackSecurityAuditInvocations", () => {
	it.effect("charges the invocations to the security-audit feature, keyed by run and agent", () =>
		Effect.gen(function* () {
			const captured: Array<Captured> = []
			yield* trackSecurityAuditInvocations({
				orgId: "org_a",
				runId: "run-1",
				agentId: "hunter-w1-1",
				invocations: 1,
			}).pipe(Effect.provide(withEnv(BILLED, captured)))
			assert.deepStrictEqual(captured, [
				{
					url: "https://api.useautumn.com/v1/balances.track",
					idempotencyKey: "run-1:hunter-w1-1:security_audit",
					body: {
						customer_id: "org_a",
						feature_id: "security_audit_invocations",
						value: 1,
						idempotency_key: "run-1:hunter-w1-1:security_audit",
						properties: { source: "security_audit", run_id: "run-1" },
					},
				},
			])
		}),
	)

	it.effect("meters nothing for Maple's own org or without a billing key", () =>
		Effect.gen(function* () {
			const captured: Array<Captured> = []
			const track = (orgId: string) =>
				trackSecurityAuditInvocations({ orgId, runId: "run-1", agentId: "recon-1", invocations: 1 })
			yield* track("org_maple").pipe(Effect.provide(withEnv(BILLED, captured)))
			yield* track("org_a").pipe(Effect.provide(withEnv({}, captured)))
			assert.deepStrictEqual(captured, [])
		}),
	)
})
