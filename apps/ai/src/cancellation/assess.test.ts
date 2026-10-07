import { assert, describe, it } from "@effect/vitest"
import { CANCELLATION_FIXTURES } from "@maple/backend/services/cancellation-review/fixtures"
import { Effect, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { layerDecisionModel } from "../platform/Llm"
import { assessCancellation } from "./assess"

const env = { CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_KEY: Redacted.make("test-key") }

const snapshot = (id: string) => {
	const fixture = CANCELLATION_FIXTURES.find((candidate) => candidate.id === id)
	if (fixture === undefined) throw new Error(`no cancellation fixture named ${id}`)
	return fixture.snapshot
}

const assess = (fetch: typeof globalThis.fetch, id = "pipeline-off") =>
	assessCancellation({ snapshot: snapshot(id), model: "@cf/cloudflare/clef" }).pipe(
		Effect.provide(layerDecisionModel(env)),
		Effect.provideService(FetchHttpClient.Fetch, fetch),
	)

const answer = {
	answers: {
		reason: {
			type: "choice",
			choice: "stopped_sending",
			probabilities: {
				never_activated: 0.02,
				stopped_sending: 0.9,
				not_engaged: 0.04,
				cost: 0.01,
				payment_failure: 0.01,
				unclear: 0.02,
			},
		},
		winBack: { type: "noul", noul: 0.18 },
	},
	usage: { input_tokens: 600, output_tokens: 40 },
}

describe("assessCancellation", () => {
	it.effect("returns the chosen reason with its own probability mass and the win-back odds", () =>
		Effect.gen(function* () {
			const assessment = yield* assess(
				(async () => new Response(JSON.stringify(answer), { status: 200 })) as typeof globalThis.fetch,
			)
			assert.strictEqual(assessment.reason, "stopped_sending")
			assert.strictEqual(assessment.reasonConfidence, 0.9)
			assert.strictEqual(assessment.winBack, 0.18)
			assert.strictEqual(assessment.model, "@cf/cloudflare/clef")
		}),
	)

	it.effect("hands the model the numbers and what the rules noticed in them", () =>
		Effect.gen(function* () {
			let state: { usage?: { plan?: unknown }; observations?: ReadonlyArray<string> } | undefined
			const fetch: typeof globalThis.fetch = async (_input, init) => {
				// SAFETY-FILE: the body is the request this test's own unit just built.
				state = JSON.parse(await new Response(init?.body ?? "{}").text()).state
				return new Response(JSON.stringify(answer), { status: 200 })
			}
			yield* assess(fetch)
			assert.deepStrictEqual(state?.usage?.plan, {
				planId: "startup",
				phase: "scheduled",
				trial: false,
				pastDue: false,
				tenureDays: 240,
				daysUntilEnd: 12,
			})
			assert.include(
				state?.observations ?? [],
				"Stopped sending telemetry 24 days ago (42 GB the month before)",
			)
		}),
	)

	it.effect("fails with the provider's error rather than inventing an answer", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				assess(
					(async () =>
						new Response(JSON.stringify({ errors: [{ message: "bad token" }] }), {
							status: 401,
						})) as typeof globalThis.fetch,
				),
			)
			assert.strictEqual(exit._tag, "Failure")
		}),
	)
})
