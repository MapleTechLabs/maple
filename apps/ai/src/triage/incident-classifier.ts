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
				"An observability platform opened this incident from a service's own telemetry. The message is the text that service emitted. Decide what the team that owns it should do.",
			criteria: {
				investigate:
					"A defect in the service itself: it crashed, corrupted or lost data, failed a write, returned a wrong answer, regressed, or hit a state it plainly did not anticipate. Something an engineer would change code to fix.",
				monitor:
					"Real but already handled: a transient failure that retried or recovered, a known flaky dependency, or a condition the service detected and reported cleanly and would survive either way.",
				noise:
					"Nothing for the team to fix, however often it fires. The user's own environment (a port already in use, a file permission they must grant, a second copy already running, a stale working directory); input the service correctly rejected; corrupt, truncated or hostile payloads from the public internet; scanners, bots and health checks; client-side cancellations; deliberate test or synthetic traffic.",
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
	// One retry, because the provider is intermittently wrong rather than broken.
	// Measured against 16 production incidents: roughly one call in sixteen comes
	// back with a score distribution that misses `DecisionModel`'s 1e-6 sum check
	// (`Invalid output: probabilities that do not sum to 1`), and the same input
	// answers cleanly on the next attempt. Effect's check has no tolerance knob,
	// and a gate that gives up at the first rounding error stops gating.
	const { answers } = yield* DecisionModel.decide(IncidentTriage, {
		input: options.request,
	}).pipe(Effect.retry({ times: 1 }))

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
