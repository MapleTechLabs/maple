/**
 * One investigation per lifecycle state, for reviewing the verdict card and the
 * run-progress feed without a stack behind them.
 *
 * Reaching these states for real costs a signed-in session, a seeded org and a
 * pass that takes minutes to reach a terminal, and two of the four (a stalled
 * run, a pass that died mid-step) cannot be produced on demand at all. The
 * fixtures are deliberately unflattering: a `suspectedCause` of the length the
 * model actually writes, a headline-less report from before the field existed,
 * and a run whose last step is old enough to read as stalled.
 */
import { V2Investigation } from "@maple/domain/http/v2"
import { Schema } from "effect"

/**
 * Fixtures are decoded, not asserted.
 *
 * The alternative is `as V2Investigation` on each one, which is exactly how a lab
 * drifts from the page it documents: the resource gains a field, the fixtures
 * keep typechecking, and the lab renders a shape the page never receives. This
 * throws at module load instead, and hands back the branded ids the components
 * are typed against without a cast anywhere.
 */
const decode = Schema.decodeUnknownSync(Schema.toType(V2Investigation))

const CREATED_AT = "2026-09-18T09:00:00.000Z"

/**
 * A start time a few minutes ago, so the running cases' elapsed stat counts up
 * from something. A fixed timestamp reads "<1s" forever, which is the one number
 * on those cards that is supposed to be alive.
 */
const startedRecently = () => new Date(Date.now() - 254_000).toISOString()

const base = (overrides: Record<string, unknown>): V2Investigation =>
	decode({
		// UUIDs, not `inv_…` public ids: the wire's public-id encoding is the
		// ENCODE direction, and these fixtures are decoded over the type side.
		id: "11111111-1111-4111-8111-111111111111",
		object: "investigation",
		status: "diagnosed",
		subject: {
			type: "incident",
			incident_kind: "error",
			incident_id: "22222222-2222-4222-8222-222222222222",
			issue_id: "33333333-3333-4333-8333-333333333333",
		},
		snapshot: {
			title: "TimeoutError: payment capture exceeded 30s",
			scope: "checkout-api",
			status: "open",
			severity: "critical",
			facts: [{ label: "Signal", value: "error_rate" }],
			references: [],
			incidentStartedAt: "2026-09-18T08:51:00.000Z",
			incidentEndedAt: "2026-09-18T09:24:00.000Z",
		},
		report: null,
		progress: null,
		model: "z-ai/glm-5.3-flash",
		severity: "critical",
		confidence: null,
		seeded_by: "system",
		created_by: null,
		input_tokens: 184_204,
		output_tokens: 7_411,
		error: null,
		created_at: CREATED_AT,
		started_at: CREATED_AT,
		diagnosed_at: null,
		updated_at: "2026-09-18T09:04:12.000Z",
		...overrides,
	})

const steps = (labels: ReadonlyArray<string>, lastAt: number) =>
	labels.map((label, index) => ({
		tool: label.split(" ")[0]!.toLowerCase(),
		label,
		at: lastAt - (labels.length - 1 - index) * 9_000,
	}))

const WALKTHROUGH = [
	"Error detail · a1f4c2e9",
	"Diagnose service · checkout-api",
	"Search logs · checkout-api",
	"Inspect trace · 7f3a9c04b1",
	"Compare periods · checkout-api",
	"Mine log patterns · checkout-api",
	"Sandbox grep · captureWithRetry",
	"Sandbox read file · src/payments/capture.ts",
]

export interface VerdictLabCase {
	readonly key: string
	readonly title: string
	/** What this case is here to catch, shown above the card. */
	readonly note: string
	readonly investigation: V2Investigation
}

export const VERDICT_LAB_CASES: ReadonlyArray<VerdictLabCase> = [
	{
		key: "diagnosed",
		title: "Diagnosed",
		note: "Headline as the heading, summary under it, the mechanism set off to one side, and the actions on the card rather than behind the graph.",
		investigation: base({
			status: "diagnosed",
			confidence: "high",
			diagnosed_at: "2026-09-18T09:04:12.000Z",
			report: {
				headline: "Retry budget exhausted in checkout-api's payment client",
				summary:
					"checkout-api started timing out on payment capture at 08:51, eight minutes after deploy 8f21c. Every failing request spent its full 30s budget inside a single synchronous retry loop. The downstream provider was healthy throughout.",
				suspectedCause:
					"Deploy 8f21c raised the payment client's retry count from 2 to 5 without lowering the per-attempt timeout, so a capture that hits a slow provider response now spends 5 × 6s inside the client before the request's own 30s budget expires. The provider itself stayed inside its normal latency band for the whole window (p99 412ms), which is why the failure presents as a client-side timeout with no corresponding upstream error: the request never fails at the provider, it runs out of clock waiting for a retry that was always going to succeed on the second attempt.",
				severityAssessment: "critical",
				affectedScope: "checkout-api payment capture, roughly 14% of checkout attempts",
				evidence: [
					{
						traceIds: ["7f3a9c04b1", "2e88d1f0aa"],
						logPatterns: ["payment capture timed out after <n>ms"],
						relatedServices: ["checkout-api", "payments-api"],
						note: "Both traces show 5 client attempts inside one server span. src/payments/capture.ts:88 at 8f21c.",
					},
				],
				suggestedActions: [
					"Roll back deploy 8f21c, or set PAYMENT_RETRY_ATTEMPTS back to 2.",
					"Drop the per-attempt timeout to 4s so the full retry budget fits inside the request budget.",
					"Add an alert on checkout-api's capture p99 crossing 20s, which would have caught this 6 minutes earlier.",
				],
				confidence: "high",
				ruledOut: [
					"Provider outage: payments-api p99 stayed at 412ms across the window, and its error rate never left baseline.",
					"Deploy of payments-api: service.version was unchanged across 41k spans in the window.",
				],
			},
		}),
	},
	{
		key: "legacy",
		title: "Diagnosed, no headline",
		note: "A report stored before `headline` existed. The heading falls back to the summary, and the mechanism is suppressed only when it would repeat the heading.",
		investigation: base({
			status: "diagnosed",
			confidence: "medium",
			diagnosed_at: "2026-09-18T09:04:12.000Z",
			report: {
				summary: "checkout-api saturated its Postgres connection pool during the 08:51 spike.",
				suspectedCause:
					"The pool is sized at 5 and the spike drove concurrent captures past that, so requests queued on connection acquisition rather than on the query itself.",
				severityAssessment: "high",
				affectedScope: "checkout-api",
				evidence: [],
				suggestedActions: ["Raise the pool ceiling and re-measure."],
				confidence: "medium",
			},
		}),
	},
	{
		key: "investigating",
		title: "Investigating",
		note: "The state the page used to answer with one sentence that never changed. The feed is the wire's step tail; the newest step pulses.",
		investigation: base({
			status: "investigating",
			diagnosed_at: null,
			created_at: startedRecently(),
			started_at: startedRecently(),
			progress: {
				stepCount: WALKTHROUGH.length,
				steps: steps(WALKTHROUGH, Date.now() - 4_000),
				updatedAt: Date.now() - 4_000,
			},
		}),
	},
	{
		key: "stalled",
		title: "Investigating, stalled",
		note: "Same state, last step four minutes old. A run waiting on a model call looks identical to one working unless the page says so.",
		investigation: base({
			status: "investigating",
			diagnosed_at: null,
			created_at: startedRecently(),
			started_at: startedRecently(),
			progress: {
				stepCount: 3,
				steps: steps(WALKTHROUGH.slice(0, 3), Date.now() - 240_000),
				updatedAt: Date.now() - 240_000,
			},
		}),
	},
	{
		key: "starting",
		title: "Investigating, no steps yet",
		note: "The gap between a pass starting and its first tool call, which is what a reader sees when they open an investigation the moment it is created.",
		investigation: base({
			status: "investigating",
			diagnosed_at: null,
			created_at: startedRecently(),
			started_at: startedRecently(),
		}),
	},
	{
		key: "inconclusive",
		title: "Inconclusive",
		note: "A result, not a defect. Warn accent, and what was ruled out is the payload.",
		investigation: base({
			status: "inconclusive",
			confidence: "low",
			progress: {
				stepCount: 6,
				steps: steps(WALKTHROUGH.slice(0, 6), Date.now() - 600_000),
				updatedAt: Date.now() - 600_000,
			},
			report: {
				headline: "No single cause established for the 08:51 timeout spike",
				summary:
					"Three plausible causes were tested and two were eliminated. The third could not be checked from telemetry available in this org.",
				suspectedCause:
					"The remaining lead is connection-pool depth in payments-api, which would produce exactly this shape, but payments-api emits no db.client.connections.* instrument so the hypothesis could not be tested either way.",
				severityAssessment: "high",
				affectedScope: "checkout-api payment capture",
				evidence: [],
				suggestedActions: [
					"Instrument payments-api's connection pool, which is what would have answered this.",
				],
				confidence: "low",
				ruledOut: [
					"Deploy: service.version was unchanged across 41k spans in the window.",
					"Downstream latency: payments-api p99 stayed at 412ms while checkout-api's tripled.",
				],
				unchecked: [
					"Connection-pool depth: payments-api emits no db.client.connections.* instrument.",
					"The 14:02 rollout: the pass ran out of clock before it reached it.",
				],
			},
		}),
	},
	{
		key: "failed",
		title: "Failed",
		note: "The case the feed is worth the most in: there is no diagnosis, so how far it got is the only account of the run that outlives the agent's event stream.",
		investigation: base({
			status: "failed",
			confidence: null,
			error: 'LanguageModel.streamText: Invalid output: Missing key at [2]["params"]["suspectedCause"]',
			progress: {
				stepCount: 5,
				steps: steps(WALKTHROUGH.slice(0, 5), Date.now() - 900_000),
				updatedAt: Date.now() - 900_000,
			},
		}),
	},
]
