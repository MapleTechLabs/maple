import { assert, describe, it } from "@effect/vitest"
import {
	AiCredits,
	AiCreditsExhausted,
	AiCreditsUnavailable,
	type AiCreditsApi,
} from "@maple/backend/services/billing/AiCredits"
import { OrgId } from "@maple/domain/primitives"
import { Effect, Option, Schema } from "effect"
import { creditRefusalError, turnCreditRefusal } from "./turn-credits"

const ORG = Schema.decodeSync(OrgId)("org_customer")
const CAP = new AiCreditsExhausted({
	message: "This organization has reached its AI spending cap.",
	reason: "cap_reached",
	resetsAt: Date.UTC(2026, 11, 1),
})

const refusalWith = (ensure: AiCreditsApi["ensure"], ownKey = false) =>
	turnCreditRefusal(ORG, ownKey).pipe(Effect.provideService(AiCredits, { ensure }))

describe("turnCreditRefusal", () => {
	it.effect("blocks the turn on a definite refusal", () =>
		Effect.gen(function* () {
			const refusal = yield* refusalWith(() => Effect.fail(CAP))
			assert.deepStrictEqual(
				Option.map(refusal, (r) => r.reason),
				Option.some("cap_reached"),
			)
		}),
	)

	it.effect("runs the turn for a plan that includes no AI credits", () =>
		Effect.gen(function* () {
			const refusal = yield* refusalWith(() =>
				Effect.fail(
					new AiCreditsExhausted({
						message: "No AI credits.",
						reason: "no_credits",
						resetsAt: null,
					}),
				),
			)
			assert.isTrue(Option.isNone(refusal))
		}),
	)

	it.effect("runs the turn when billing cannot be reached", () =>
		Effect.gen(function* () {
			const refusal = yield* refusalWith(() =>
				Effect.fail(new AiCreditsUnavailable({ message: "Transport error" })),
			)
			assert.isTrue(Option.isNone(refusal))
		}),
	)

	it.effect("tells the gate when the turn runs on the org's own key", () =>
		Effect.gen(function* () {
			const refusal = yield* refusalWith(
				(_orgId, options) => (options?.ownKey === true ? Effect.void : Effect.fail(CAP)),
				true,
			)
			assert.isTrue(Option.isNone(refusal))
		}),
	)
})

describe("creditRefusalError", () => {
	it("leads with a readable code, then the message the org sees", () => {
		assert.strictEqual(
			creditRefusalError(CAP),
			"ai_credits_cap_reached: This organization has reached its AI spending cap.",
		)
	})
})
