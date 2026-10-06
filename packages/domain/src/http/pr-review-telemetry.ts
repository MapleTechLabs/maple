import { Schema } from "effect"

/**
 * What a review learned from the organization's own telemetry, computed by the service rather than
 * asked of the model: the same diff against the same warehouse always gives the same facts.
 *
 * Every list is bounded and every count is per day over the window the review read.
 */

/** The three kinds of name a diff can stop emitting. */
export const PrReviewTelemetryKind = Schema.Literals(["span", "attribute", "metric"]).annotate({
	identifier: "@maple/PrReviewTelemetryKind",
	title: "Pull Request Review Telemetry Kind",
})
export type PrReviewTelemetryKind = Schema.Schema.Type<typeof PrReviewTelemetryKind>

/** An alert rule or dashboard that reads a name. */
export class PrReviewTelemetryReference extends Schema.Class<PrReviewTelemetryReference>(
	"PrReviewTelemetryReference",
)({
	kind: Schema.Literals(["alert", "dashboard"]),
	id: Schema.String,
	name: Schema.String,
}) {}

/**
 * A name the organization emits today, that an alert or dashboard reads, and that the diff removes
 * without adding back anywhere. `line` is on the new side, where the removal happened.
 *
 * `dismissed` is the reviewer's evidence that the name is still emitted elsewhere at the head; the
 * service checks that file before accepting it, so a dismissal is a fact too.
 */
export class PrReviewContractBreak extends Schema.Class<PrReviewContractBreak>("PrReviewContractBreak")({
	kind: PrReviewTelemetryKind,
	name: Schema.String,
	path: Schema.String,
	line: Schema.Number,
	references: Schema.Array(PrReviewTelemetryReference),
	/** How often the name arrived per day; absent when the warehouse did not count it. */
	perDay: Schema.optionalKey(Schema.Number),
	dismissed: Schema.optionalKey(Schema.Struct({ path: Schema.String, line: Schema.Number })),
}) {}

/** One production operation a changed file names. */
export class PrReviewOperationTraffic extends Schema.Class<PrReviewOperationTraffic>(
	"PrReviewOperationTraffic",
)({
	service: Schema.String,
	spanName: Schema.String,
	perDay: Schema.Number,
	errorRate: Schema.Number,
	p95Ms: Schema.Number,
}) {}

/** A changed file and the production traffic of the operations it names. */
export class PrReviewHotFile extends Schema.Class<PrReviewHotFile>("PrReviewHotFile")({
	path: Schema.String,
	perDay: Schema.Number,
	operations: Schema.Array(PrReviewOperationTraffic),
}) {}

/** An open error issue whose top stack frame is in a changed file. */
export class PrReviewLinkedIssue extends Schema.Class<PrReviewLinkedIssue>("PrReviewLinkedIssue")({
	issueId: Schema.String,
	fingerprintHash: Schema.String,
	title: Schema.String,
	service: Schema.String,
	path: Schema.String,
	topFrame: Schema.String,
	occurrences: Schema.Number,
	lastSeenAt: Schema.Number,
}) {}

/** What added code costs to ingest, from the traffic of the file it is in. */
export class PrReviewCostNote extends Schema.Class<PrReviewCostNote>("PrReviewCostNote")({
	path: Schema.String,
	line: Schema.Number,
	kind: Schema.Literals(["log", "span_name"]),
	/** Estimated ingest per month; absent when the file has no measured traffic. */
	gbPerMonth: Schema.optionalKey(Schema.Number),
	note: Schema.String,
}) {}

/** A name the diff adds or removes, as the warehouse knows it. */
export class PrReviewTelemetryChange extends Schema.Class<PrReviewTelemetryChange>("PrReviewTelemetryChange")(
	{
		kind: PrReviewTelemetryKind,
		name: Schema.String,
		path: Schema.String,
		line: Schema.Number,
		perDay: Schema.optionalKey(Schema.Number),
	},
) {}

export class PrReviewTelemetry extends Schema.Class<PrReviewTelemetry>("PrReviewTelemetry")({
	/** Days of production telemetry the facts were read from. */
	windowDays: Schema.Number,
	/** Services whose operations the diff names, busiest first. */
	services: Schema.Array(Schema.String),
	contractBreaks: Schema.Array(PrReviewContractBreak),
	hotFiles: Schema.Array(PrReviewHotFile),
	linkedIssues: Schema.Array(PrReviewLinkedIssue),
	costNotes: Schema.Array(PrReviewCostNote),
	added: Schema.Array(PrReviewTelemetryChange),
	removed: Schema.Array(PrReviewTelemetryChange),
}) {}

/** Breaks the reviewer did not disprove: the ones that block a merge when the repository asks. */
export const openContractBreaks = (telemetry: PrReviewTelemetry | undefined) =>
	(telemetry?.contractBreaks ?? []).filter((item) => item.dismissed === undefined)

/** One operation before and after the deploy that shipped the pull request. */
export class PrReviewPostMergeOperation extends Schema.Class<PrReviewPostMergeOperation>(
	"PrReviewPostMergeOperation",
)({
	service: Schema.String,
	spanName: Schema.String,
	before: Schema.Struct({ perHour: Schema.Number, errorRate: Schema.Number, p95Ms: Schema.Number }),
	after: Schema.Struct({ perHour: Schema.Number, errorRate: Schema.Number, p95Ms: Schema.Number }),
	regressed: Schema.Boolean,
}) {}

/** An error issue's rate before and after the deploy. */
export class PrReviewPostMergeIssue extends Schema.Class<PrReviewPostMergeIssue>("PrReviewPostMergeIssue")({
	issueId: Schema.String,
	title: Schema.String,
	service: Schema.String,
	beforePerHour: Schema.Number,
	afterPerHour: Schema.Number,
}) {}

/**
 * What the reviewer saw after the pull request shipped: the deploy, the operations it touched, and
 * the error issues around it. Posted once on the merged pull request.
 */
export class PrReviewPostMerge extends Schema.Class<PrReviewPostMerge>("PrReviewPostMerge")({
	deploy: Schema.Struct({
		service: Schema.String,
		environment: Schema.String,
		commitSha: Schema.String,
		firstSeenAt: Schema.Number,
		/** False when the merge commit itself never reported and the first later version stands in. */
		exact: Schema.Boolean,
	}),
	windowMinutes: Schema.Number,
	operations: Schema.Array(PrReviewPostMergeOperation),
	/** Issues first seen after the deploy, in the services it touched. */
	newIssues: Schema.Array(PrReviewPostMergeIssue),
	/** Issues the review linked to the changed files, and whether they stopped. */
	linkedIssues: Schema.Array(PrReviewPostMergeIssue),
	/** Names the review saw removed that still arrive, or that alerts read and no longer arrive. */
	missing: Schema.Array(Schema.String),
	verdict: Schema.Literals(["clean", "regressed"]),
}) {}

export const PrReviewPostMergeStatus = Schema.Literals([
	"waiting",
	"reported",
	"no_deploy",
	"no_traffic",
]).annotate({
	identifier: "@maple/PrReviewPostMergeStatus",
	title: "Pull Request Review Post-Merge Status",
})
export type PrReviewPostMergeStatus = Schema.Schema.Type<typeof PrReviewPostMergeStatus>
