/**
 * A review turn's progress, kept in its session's SQLite by kickoff, so the attempts a Durable
 * Object reset restarts, and the partial filed when they are spent, keep what earlier ones found.
 */
import { PrReviewFinding, PrReviewFindingSubmission, type SubmitPrReviewRequest } from "@maple/domain/http"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { makeRunUsage } from "../usage"
import { closeOutFindings, makeChildFindings } from "./child-findings"
import { type ReviewTurnState, savedFindingsRequest } from "./completion"
import { makeReviewCoverage } from "./coverage"
import { makeReviewLedger } from "./ledger"

export const ReviewCheckpoint = Schema.Struct({
	/** What `record_finding` saved. */
	saved: Schema.Array(PrReviewFinding),
	/** What the `review_files` children reported. */
	children: Schema.Array(PrReviewFindingSubmission),
	/** Reviewed files due, and the ones any attempt has read. */
	due: Schema.Array(Schema.String),
	read: Schema.Array(Schema.String),
	/** The review model, which a partial filed after the last attempt names. */
	model: Schema.String,
})
export type ReviewCheckpoint = typeof ReviewCheckpoint.Type

const ReviewCheckpointJson = Schema.fromJsonString(ReviewCheckpoint)
/** None for a missing or unreadable row: a checkpoint only ever adds to a review. */
export const decodeReviewCheckpoint = (raw: string | undefined): Option.Option<ReviewCheckpoint> =>
	raw === undefined ? Option.none() : Schema.decodeOption(ReviewCheckpointJson)(raw)
export const encodeReviewCheckpoint = Schema.encodeSync(ReviewCheckpointJson)

/** The findings an abandoned review posts as its partial, and the files no attempt read. */
export const abandonedReviewPartial = (checkpoint: ReviewCheckpoint) => ({
	findings: closeOutFindings(checkpoint.saved, checkpoint.children),
	unreviewed: Arr.filter(checkpoint.due, (path) => !checkpoint.read.includes(path)),
})

/** How long filing an abandoned review's partial may take; a bare failure is recorded after it. */
const FILE_ABANDONED_TIMEOUT = "60 seconds"

/**
 * File what the dead attempts found as a partial naming the files none read, instead of a bare
 * `interrupted`. False when there is nothing to file or filing failed; the review is then failed.
 */
export const fileAbandonedReview = <E>(input: {
	readonly checkpoint: Option.Option<ReviewCheckpoint>
	readonly submit: (request: SubmitPrReviewRequest) => Effect.Effect<unknown, E>
}): Effect.Effect<boolean> => {
	if (Option.isNone(input.checkpoint)) return Effect.succeed(false)
	const { findings, unreviewed } = abandonedReviewPartial(input.checkpoint.value)
	if (findings.length === 0) return Effect.succeed(false)
	return input
		.submit(
			savedFindingsRequest({
				findings,
				unreviewed,
				modelName: input.checkpoint.value.model,
				// The dead attempts' spend was metered by them, or lost with them.
				usage: makeRunUsage(),
				reason: "interrupted",
			}),
		)
		.pipe(
			Effect.as(true),
			Effect.timeout(FILE_ABANDONED_TIMEOUT),
			Effect.catchCause((cause) =>
				Effect.logError("Could not file an abandoned review's findings", cause).pipe(
					Effect.as(false),
				),
			),
		)
}

/**
 * The turn's review state, seeded from earlier attempts and saved on every change. Findings carry
 * over; reads do not, since this attempt has not seen those diffs, and only name what was never read.
 */
export const checkpointedReviewState = (input: {
	readonly kickoff: string
	readonly model: string
	readonly prior: Option.Option<ReviewCheckpoint>
	readonly save: (checkpoint: ReviewCheckpoint) => void
}): ReviewTurnState => {
	const prior = Option.getOrUndefined(input.prior)
	const coverage = makeReviewCoverage(input.kickoff)
	const ledger = makeReviewLedger(prior?.saved ?? [])
	const childFindings = makeChildFindings(prior?.children ?? [])
	const persist = () => {
		const progress = coverage.progress()
		input.save({
			saved: ledger.findings(),
			children: childFindings.all(),
			due: Arr.dedupe([...(prior?.due ?? []), ...progress.due]),
			read: Arr.dedupe([...(prior?.read ?? []), ...progress.read]),
			model: input.model,
		})
	}
	return {
		coverage: {
			...coverage,
			observe: (tool, answer) => {
				coverage.observe(tool, answer)
				// Every Maple answer comes through here; only these two change what is due or read.
				if (tool === "pr_changed_files" || tool === "pr_file_diff") persist()
			},
		},
		ledger: {
			...ledger,
			record: (finding) => {
				const outcome = ledger.record(finding)
				if (outcome === "recorded") persist()
				return outcome
			},
		},
		childFindings: {
			...childFindings,
			observe: (answer) => {
				childFindings.observe(answer)
				persist()
			},
		},
	}
}
