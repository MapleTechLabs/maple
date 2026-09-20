/**
 * The pre-LLM incident triage: one Jev decision, before an investigation is
 * allowed to spend a model pass.
 *
 * This is deliberately NOT an agent turn. An investigation is one turn
 * (CLAUDE.md), so the thing that decides whether to run it has to sit outside —
 * a decision model answers bounded questions in a single call with no tools, no
 * transcript and no session, which is exactly what a gate can afford.
 */
import {
	IncidentTriageRequest,
	IncidentTriageVerdict,
	type IssueSeverity,
} from "@maple/domain/http"
import { Effect } from "effect"
import { Decision, DecisionModel } from "effect/unstable/ai"

/** The severity scale, ordered as `Decision.rate` needs it: least to most urgent. */
const SEVERITY_SCALE = ["low", "medium", "high", "critical"] as const satisfies ReadonlyArray<IssueSeverity>

/**
 * The questions. Their wording is the product behaviour — a label is only as
 * good as the sentence describing it — so they live here rather than in a
 * prompt file, next to the schema that carries the answers.
 */
export const IncidentTriage = Decision.make({
	input: IncidentTriageRequest,
	decisions: {
		disposition: Decision.classify({
			instructions:
				"An observability platform opened this incident. Decide what it deserves from an engineering team.",
			criteria: {
				investigate:
					"A real defect or regression worth an engineer's time: something broke, started failing, or got materially slower for users of the service.",
				monitor:
					"Real but unremarkable: a single transient failure, a known flaky dependency, an expected retry or timeout, or something already understood and accepted.",
				noise: "Not worth anyone's time: scanner and bot traffic, malformed requests from the public internet, client-side cancellations and disconnects, health checks, or deliberate test and synthetic traffic.",
			},
		}),
		severity: Decision.rate({
			instructions:
				"How urgent is this for the on-call engineer, judging by how much of the system is degraded and how many users it reaches.",
			criteria: SEVERITY_SCALE,
		}),
		userImpact: Decision.probability({
			instructions: "Would a real customer have noticed this?",
			criteria: {
				true: "A user saw an error, a hang, or a wrong result.",
				false: "Contained: retried, degraded invisibly, or only ever seen by the platform.",
			},
		}),
	},
})

/**
 * Ask the decision model about one incident.
 *
 * Fails only with the provider's own `AiError`; the caller decides what an
 * unanswered question means, and in the enqueue path it means "investigate".
 */
export const classifyIncident = Effect.fn("classifyIncident")(function* (options: {
	readonly request: IncidentTriageRequest
	readonly model: string
}) {
	const { answers } = yield* DecisionModel.decide(IncidentTriage, { input: options.request })

	// The chosen label's own probability mass, not the provider's optional
	// `confidence`: the distribution is what the gate's threshold is written
	// against, and it is always present.
	const dispositionConfidence =
		answers.disposition.probabilities[answers.disposition.label] ??
		answers.disposition.confidence ??
		0
	const severityConfidence =
		answers.severity.probabilities[answers.severity.label] ?? answers.severity.confidence ?? 0

	return new IncidentTriageVerdict({
		disposition: answers.disposition.label,
		dispositionConfidence: clamp(dispositionConfidence),
		severity: answers.severity.label,
		severityConfidence: clamp(severityConfidence),
		userImpact: clamp(answers.userImpact.probability),
		model: options.model,
	})
})

/** The schema rejects anything outside `[0, 1]`, and a provider is not a contract. */
const clamp = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)
