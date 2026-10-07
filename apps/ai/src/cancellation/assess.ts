/**
 * The model's half of a cancellation review: one decision over the usage
 * snapshot, answering what the numbers point to and whether writing to the org
 * is worth it.
 *
 * A decision model rather than an agent turn for the same reason incident
 * triage is one: the questions are bounded, the input is already gathered, and
 * the answer has to be comparable from one cancellation to the next.
 */
import { deriveSignals } from "@maple/backend/services/cancellation-review/signals"
import { CancellationAssessment, type CancellationReason, CancellationSnapshot } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Decision, DecisionModel } from "effect/ai"

/** The wording is the product behaviour, so it lives next to the schema it answers into. */
export const REASON_CRITERIA = {
	never_activated:
		"Never got going. No telemetry ever arrived, or only a few days of a small test, and little or nothing was set up.",
	stopped_sending:
		"Used it for real, then switched it off. Telemetry that had been flowing for weeks stopped or shrank to a trickle well before the cancellation, with no bill increase before it.",
	not_engaged:
		"Telemetry is still flowing at its usual volume but people stopped opening the app: no visits for weeks, or visits collapsed against the month before.",
	cost: "The bill is the visible change. The latest invoice is well above the one before it, or usage ran past the plan's included allowance, whether or not the org cut its volume afterwards.",
	payment_failure: "Not a choice. The subscription is past due and ended because payment failed.",
	unclear:
		"Nothing in the numbers explains it. Telemetry is steady, people are in the app regularly, and the bill is flat. An ordinary month-to-month dip is not a reason.",
} satisfies Record<CancellationReason, string>

/**
 * The numbers, plus the rule-derived sentences about them. Measured on the
 * shared fixtures with Jev: the sentences took the model from 33/39 to 36/39
 * and removed every run-to-run flip, so it reads both.
 */
const CancellationDecisionInput = Schema.Struct({
	usage: CancellationSnapshot,
	observations: Schema.Array(Schema.String),
})

export const CancellationDecision = Decision.make({
	input: CancellationDecisionInput,
	decisions: {
		reason: Decision.classify({
			instructions:
				"An observability platform's customer cancelled their paid plan. `usage` is that customer's own numbers: `recent` is the 30 days before the cancellation and `prior` the 30 days before that; a null section could not be read and says nothing. `observations` are what fixed rules already noticed in those numbers. Pick the reason the usage points to.",
			criteria: REASON_CRITERIA,
		}),
		winBack: Decision.probability({
			instructions:
				"Would a personal note from the team plausibly keep this customer or bring them back?",
			criteria: {
				true: "They got real value recently: telemetry flowing, people in the app, things set up. What pushed them out looks fixable, such as a bill, a failed payment, or something a conversation would surface.",
				false: "They never adopted it, or they wound down weeks ago and have already moved on.",
			},
		}),
	},
})

/** The schema rejects anything outside `[0, 1]`, and a provider is not a contract. */
const clamp = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)

/**
 * Ask the decision model about one cancellation. Fails only with the provider's
 * own `AiError`; one retry of what it marks retryable, as incident triage does.
 */
export const assessCancellation = Effect.fn("assessCancellation")(function* (options: {
	readonly snapshot: CancellationSnapshot
	readonly model: string
}) {
	const { answers } = yield* DecisionModel.decide(CancellationDecision, {
		input: {
			usage: options.snapshot,
			observations: deriveSignals(options.snapshot).map((signal) => signal.text),
		},
	}).pipe(Effect.retry({ times: 1, while: (error) => error.isRetryable }))
	return new CancellationAssessment({
		reason: answers.reason.label,
		reasonConfidence: clamp(
			answers.reason.probabilities[answers.reason.label] ?? answers.reason.confidence ?? 0,
		),
		winBack: clamp(answers.winBack.probability),
		model: options.model,
	})
})
