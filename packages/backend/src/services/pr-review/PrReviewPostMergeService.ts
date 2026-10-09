/**
 * After a reviewed pull request merges, look at production once it ships and say how it went on
 * the pull request: the deploy that carried it, the operations its files touch, new errors, and
 * whether the errors the review linked to its files stopped.
 *
 * Polled, like fix verification: the merge stamps a due time on the merged head's review, and a
 * cron tick picks up due rows. No queue delay limit applies, and a deploy that comes a day later
 * is still found.
 */
import {
	openContractBreaks,
	type OrgId,
	type PrReviewId,
	PrReviewPostMerge,
	PrReviewPostMergeIssue,
	type PrReviewPostMergeStatus,
	PrReviewTelemetry,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { PrReviews, type PrReviewRow } from "@maple/db/tables"
import { Context, DateTime, Duration, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { VcsProviderRegistry } from "@maple/backend/services/integrations/vcs/VcsProviderRegistry"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import { PrReviewTelemetryService } from "./telemetry/PrReviewTelemetryService"
import {
	compareOperations,
	comparedOperations,
	missingAfterDeploy,
	pickDeploy,
	elapsed,
	POST_MERGE_GIVE_UP,
	POST_MERGE_RETRY,
	POST_MERGE_WINDOW,
	postMergeServices,
	renderPostMergeComment,
} from "./telemetry/post-merge"

/** Rows one tick looks at; each costs a handful of warehouse reads. */
const TICK_LIMIT = 10
/** How long a tick holds a row it is examining; longer than one examination takes. */
const CLAIM = Duration.minutes(10)
/** After the window closes, time for the minutely rollups to land before it is read. */
const ROLLUP_LAG = Duration.minutes(5)

export interface PostMergeTickResult {
	readonly examined: number
	readonly reported: number
	readonly waiting: number
	readonly gaveUp: number
	readonly failedRows: number
}

export interface PrReviewPostMergeServiceApi {
	/** Never fails: a row that cannot be looked at now is looked at again later. */
	readonly runTick: () => Effect.Effect<PostMergeTickResult>
}

type Outcome = "reported" | "waiting" | "gave_up" | "skipped"

const encodePostMerge = Schema.encodeEffect(PrReviewPostMerge)
// Lenient: a document stored in an older shape reads as no facts, so its row gives up rather than
// failing the whole tick's read.
const decodeTelemetry = Schema.decodeUnknownOption(PrReviewTelemetry)

/** A due review, its telemetry as stored. */
type DueRow = Omit<PrReviewRow, "telemetryJson"> & { readonly telemetryJson: unknown }
const toMs = DateTime.toEpochMillis

export class PrReviewPostMergeService extends Context.Service<
	PrReviewPostMergeService,
	PrReviewPostMergeServiceApi
>()("@maple/backend/services/pr-review/PrReviewPostMergeService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const telemetry = yield* PrReviewTelemetryService
		const repositories = yield* VcsRepository
		const providers = yield* VcsProviderRegistry

		const settle = (
			orgId: OrgId,
			id: PrReviewId,
			status: PrReviewPostMergeStatus,
			postMergeAfter: number | null,
			now: DateTime.Utc,
		) =>
			database.execute((db) =>
				db.run(
					PG.update(PrReviews)
						.set({ postMergeStatus: status, updatedAt: toMs(now), postMergeAfter })
						.where(($) => [$.orgId.eq(orgId), $.id.eq(id)]),
				),
			)

		const later = (orgId: OrgId, id: PrReviewId, at: DateTime.Utc, now: DateTime.Utc) =>
			settle(orgId, id, "waiting", toMs(at), now)

		const examine = Effect.fn("PrReviewPostMerge.examine")(function* (
			row: DueRow,
			now: DateTime.Utc,
			/** The lease this examination holds; it reports only while the row still carries it. */
			leaseUntil: DateTime.Utc,
		) {
			const orgId = row.orgId
			const mergedAt = row.mergedAt === null ? now : DateTime.makeUnsafe(row.mergedAt)
			yield* Effect.annotateCurrentSpan({ orgId, "maple.pr_review.id": row.id })
			const facts = Option.getOrUndefined(decodeTelemetry(row.telemetryJson))
			const services = facts === undefined ? [] : postMergeServices(facts)
			// A review that only found a removed name has no service to narrow by: it reads every
			// service's versions and waits for the merge commit itself.
			const breaksOnly =
				facts !== undefined && services.length === 0 && openContractBreaks(facts).length > 0
			if (facts === undefined || (services.length === 0 && !breaksOnly)) {
				yield* settle(orgId, row.id, "no_traffic", null, now)
				return "gave_up" satisfies Outcome
			}
			const versions = yield* telemetry.deploymentsSince(orgId, services, mergedAt, now)
			const commitTimes = yield* telemetry.commitTimes(
				orgId,
				row.repositoryId,
				versions.map((version) => version.commitSha),
			)
			const picked = pickDeploy({
				versions,
				mergeCommitSha: row.mergeCommitSha,
				mergedAt,
				now,
				commitTimes,
				exactOnly: breaksOnly,
			})
			if (picked === undefined) {
				if (elapsed(mergedAt, now, POST_MERGE_GIVE_UP)) {
					yield* settle(orgId, row.id, "no_deploy", null, now)
					return "gave_up" satisfies Outcome
				}
				yield* later(orgId, row.id, DateTime.addDuration(now, POST_MERGE_RETRY), now)
				return "waiting" satisfies Outcome
			}
			const deployAt = picked.deploy.firstSeen
			const windowStart = DateTime.subtractDuration(deployAt, POST_MERGE_WINDOW)
			const windowEnd = DateTime.addDuration(deployAt, POST_MERGE_WINDOW)
			// A full window of traffic after the deploy, and its rollups landed.
			const readable = DateTime.addDuration(windowEnd, ROLLUP_LAG)
			if (DateTime.isLessThan(now, readable)) {
				yield* later(orgId, row.id, readable, now)
				return "waiting" satisfies Outcome
			}

			const operations = comparedOperations(facts)
			const spanNames = operations.map((operation) => operation.spanName)
			const linked = facts.linkedIssues.map((issue) => issue.fingerprintHash)
			const [before, after, linkedBefore, linkedAfter, fresh, arriving] = yield* Effect.all(
				[
					spanNames.length === 0
						? Effect.succeed([])
						: telemetry.operationsIn(orgId, services, spanNames, windowStart, deployAt),
					spanNames.length === 0
						? Effect.succeed([])
						: telemetry.operationsIn(orgId, services, spanNames, deployAt, windowEnd),
					telemetry.issueCountsIn(orgId, linked, windowStart, deployAt),
					telemetry.issueCountsIn(orgId, linked, deployAt, windowEnd),
					telemetry.issuesFirstSeenSince(orgId, services, deployAt),
					telemetry.attributeKeysIn(orgId, deployAt, windowEnd),
				],
				{ concurrency: 3 },
			)
			const freshCounts = yield* telemetry.issueCountsIn(
				orgId,
				fresh.map((issue) => issue.fingerprintHash),
				deployAt,
				windowEnd,
			)
			const hours = Duration.toHours(POST_MERGE_WINDOW)
			const compared = compareOperations(facts, before, after)
			const newIssues = fresh
				// Fresh issues from before this deploy's hour belong to an earlier one.
				.filter((issue) => (freshCounts.get(issue.fingerprintHash) ?? 0) > 0)
				.slice(0, 10)
				.map(
					(issue) =>
						new PrReviewPostMergeIssue({
							issueId: issue.id,
							title: issue.title,
							service: issue.service,
							beforePerHour: 0,
							afterPerHour: Math.round((freshCounts.get(issue.fingerprintHash) ?? 0) / hours),
						}),
				)
			const linkedIssues = facts.linkedIssues.map(
				(issue) =>
					new PrReviewPostMergeIssue({
						issueId: issue.issueId,
						title: issue.title,
						service: issue.service,
						beforePerHour: Math.round((linkedBefore.get(issue.fingerprintHash) ?? 0) / hours),
						afterPerHour: Math.round((linkedAfter.get(issue.fingerprintHash) ?? 0) / hours),
					}),
			)
			// An empty key set means the read failed, not that every name stopped.
			const missing = arriving.size === 0 ? [] : missingAfterDeploy(facts, arriving)
			const regressed =
				compared.some((operation) => operation.regressed) ||
				newIssues.length > 0 ||
				missing.length > 0
			const report = new PrReviewPostMerge({
				deploy: {
					service: picked.deploy.service,
					environment: picked.deploy.environment,
					commitSha: picked.deploy.commitSha,
					firstSeen: deployAt,
					exact: picked.exact,
				},
				windowMinutes: Duration.toMinutes(POST_MERGE_WINDOW),
				operations: compared,
				newIssues,
				linkedIssues,
				missing,
				verdict: regressed ? "regressed" : "clean",
			})

			// Stored before the post, and only while this examination still holds its lease: one that
			// outlived it lost the row to a later tick, which reports instead. A refused post still
			// leaves the look on the review.
			const stored = yield* encodePostMerge(report)
			const won = yield* database.execute((db) =>
				db.run(
					PG.update(PrReviews)
						.set({
							postMergeStatus: "reported",
							postMergeAfter: null,
							postMergeJson: stored,
							updatedAt: toMs(now),
						})
						.where(($) => [
							$.id.eq(row.id),
							$.postMergeStatus.eq("waiting"),
							$.postMergeAfter.eq(toMs(leaseUntil)),
						])
						.returning("id"),
				),
			)
			if (won.length === 0) return "skipped" satisfies Outcome
			yield* Effect.annotateCurrentSpan({
				"maple.pr_review.post_merge.verdict": report.verdict,
				"maple.pr_review.post_merge.exact_deploy": picked.exact,
				"maple.pr_review.post_merge.operations": compared.length,
				"maple.pr_review.post_merge.new_issues": newIssues.length,
				"maple.pr_review.post_merge.missing": missing.length,
			})
			yield* postComment(orgId, row, renderPostMergeComment(row.id, report))
			return "reported" satisfies Outcome
		})

		const postComment = (orgId: OrgId, row: DueRow, body: string) =>
			Effect.gen(function* () {
				const repository = yield* repositories.getRepositoryById(orgId, row.repositoryId)
				if (Option.isNone(repository)) return
				const installation = yield* repositories.getInstallationById(
					orgId,
					repository.value.installationId,
				)
				if (Option.isNone(installation)) return
				const provider = yield* providers.resolve(repository.value.provider)
				const repo = repository.value
				yield* provider.postPullRequestReply(
					installation.value,
					{ externalRepoId: repo.externalRepoId, owner: repo.owner, name: repo.name },
					{ number: row.number, body },
				)
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("[PrReviewPostMerge] could not post the follow-up").pipe(
						Effect.annotateLogs({ orgId, reviewId: row.id, cause: summarizeCause(cause) }),
					),
				),
			)

		const runTick: PrReviewPostMergeServiceApi["runTick"] = () =>
			Effect.gen(function* () {
				const now = yield* DateTime.now
				const due = yield* database.execute((db) =>
					db.run(
						PG.from(PrReviews)
							.select(($) => ({ ...$, telemetryJson: PG.undecoded($.telemetryJson) }))
							.where(($) => [$.postMergeStatus.eq("waiting"), $.postMergeAfter.lte(toMs(now))])
							.orderBy(["postMergeAfter", "asc"])
							.limit(TICK_LIMIT),
					),
				)
				const outcomes = yield* Effect.forEach(
					due,
					(row) =>
						Effect.gen(function* () {
							const leaseUntil = DateTime.addDuration(now, CLAIM)
							// Claimed first: an overlapping tick that read the same row finds it leased and
							// skips it, so the follow-up is posted once.
							const claimed = yield* database.execute((db) =>
								db.run(
									PG.update(PrReviews)
										.set({ postMergeAfter: toMs(leaseUntil) })
										.where(($) => [
											$.id.eq(row.id),
											$.postMergeStatus.eq("waiting"),
											$.postMergeAfter.lte(toMs(now)),
										])
										.returning("id"),
								),
							)
							if (claimed.length === 0) return "skipped" as const
							return yield* examine(row, now, leaseUntil)
						}).pipe(
							Effect.map((outcome): Outcome | "failed" | "skipped" => outcome),
							Effect.catchCause((cause) => {
								const mergedAt =
									row.mergedAt === null ? now : DateTime.makeUnsafe(row.mergedAt)
								// A read that keeps failing is given up with the rest, never read as clean.
								const giveUp = elapsed(mergedAt, now, POST_MERGE_GIVE_UP)
								return Effect.logWarning(
									"[PrReviewPostMerge] could not examine a merged review",
								).pipe(
									Effect.annotateLogs({
										orgId: row.orgId,
										reviewId: row.id,
										cause: summarizeCause(cause),
									}),
									Effect.andThen(
										(giveUp
											? settle(row.orgId, row.id, "failed", null, now)
											: later(
													row.orgId,
													row.id,
													DateTime.addDuration(now, POST_MERGE_RETRY),
													now,
												)
										).pipe(Effect.ignore),
									),
									Effect.as("failed" as const),
								)
							}),
						),
					{ concurrency: 2 },
				)
				const count = (outcome: Outcome | "failed" | "skipped") =>
					outcomes.filter((value) => value === outcome).length
				return {
					examined: due.length - count("skipped"),
					reported: count("reported"),
					waiting: count("waiting"),
					gaveUp: count("gave_up"),
					failedRows: count("failed"),
				}
			}).pipe(
				Effect.withSpan("PrReviewPostMergeService.runTick"),
				Effect.catchCause((cause) =>
					Effect.logWarning("[PrReviewPostMerge] tick failed").pipe(
						Effect.annotateLogs({ cause: summarizeCause(cause) }),
						Effect.as({ examined: 0, reported: 0, waiting: 0, gaveUp: 0, failedRows: 1 }),
					),
				),
			)

		return { runTick } satisfies PrReviewPostMergeServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(PrReviewTelemetryService.layer, VcsRepository.layer, VcsProviderRegistry.layer),
		),
	)
}
