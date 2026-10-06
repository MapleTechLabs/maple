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
import { prReviews } from "@maple/db"
import { and, asc, eq, lte } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { dateToMs, msToDate } from "@maple/backend/platform/time"
import { VcsProviderRegistry } from "@maple/backend/services/integrations/vcs/VcsProviderRegistry"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import { PrReviewTelemetryService } from "./telemetry/PrReviewTelemetryService"
import {
	compareOperations,
	comparedOperations,
	missingAfterDeploy,
	pickDeploy,
	POST_MERGE_GIVE_UP_MS,
	POST_MERGE_RETRY_MS,
	POST_MERGE_WINDOW_MINUTES,
	postMergeServices,
	renderPostMergeComment,
} from "./telemetry/post-merge"

/** Rows one tick looks at; each costs a handful of warehouse reads. */
const TICK_LIMIT = 10
const WINDOW_MS = POST_MERGE_WINDOW_MINUTES * 60_000
/** How long a tick holds a row it is examining; longer than one examination takes. */
const CLAIM_MS = 10 * 60_000

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

const decodeTelemetry = Schema.decodeUnknownOption(PrReviewTelemetry)

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
			values: Partial<typeof prReviews.$inferInsert>,
			nowMs: number,
		) =>
			database.execute((db) =>
				db
					.update(prReviews)
					.set({ postMergeStatus: status, updatedAt: msToDate(nowMs), ...values })
					.where(and(eq(prReviews.orgId, orgId), eq(prReviews.id, id))),
			)

		const later = (orgId: OrgId, id: PrReviewId, atMs: number, nowMs: number) =>
			settle(orgId, id, "waiting", { postMergeAfter: msToDate(atMs) }, nowMs)

		const examine = Effect.fn("PrReviewPostMerge.examine")(function* (
			row: typeof prReviews.$inferSelect,
			nowMs: number,
			/** The lease this examination holds; it reports only while the row still carries it. */
			leaseUntilMs: number,
		) {
			const orgId = row.orgId
			const mergedAtMs = dateToMs(row.mergedAt) ?? nowMs
			yield* Effect.annotateCurrentSpan({ orgId, "maple.pr_review.id": row.id })
			const facts = Option.getOrUndefined(decodeTelemetry(row.telemetryJson))
			const services = facts === undefined ? [] : postMergeServices(facts)
			// A review that only found a removed name has no service to narrow by: it reads every
			// service's versions and waits for the merge commit itself.
			const breaksOnly =
				facts !== undefined && services.length === 0 && openContractBreaks(facts).length > 0
			if (facts === undefined || (services.length === 0 && !breaksOnly)) {
				yield* settle(orgId, row.id, "no_traffic", { postMergeAfter: null }, nowMs)
				return "gave_up" satisfies Outcome
			}
			const versions = yield* telemetry.deploymentsSince(orgId, services, mergedAtMs, nowMs)
			const commitTimes = yield* telemetry.commitTimes(
				orgId,
				row.repositoryId,
				versions.map((version) => version.commitSha),
			)
			const picked = pickDeploy({
				versions,
				mergeCommitSha: row.mergeCommitSha,
				mergedAtMs,
				nowMs,
				commitTimes,
				exactOnly: breaksOnly,
			})
			if (picked === undefined) {
				if (nowMs - mergedAtMs > POST_MERGE_GIVE_UP_MS) {
					yield* settle(orgId, row.id, "no_deploy", { postMergeAfter: null }, nowMs)
					return "gave_up" satisfies Outcome
				}
				yield* later(orgId, row.id, nowMs + POST_MERGE_RETRY_MS, nowMs)
				return "waiting" satisfies Outcome
			}
			const deployAt = picked.deploy.firstSeenAt
			// A full hour of traffic after the deploy, plus a few minutes for the rollups to land.
			if (nowMs < deployAt + WINDOW_MS + 5 * 60_000) {
				yield* later(orgId, row.id, deployAt + WINDOW_MS + 5 * 60_000, nowMs)
				return "waiting" satisfies Outcome
			}

			const operations = comparedOperations(facts)
			const spanNames = operations.map((operation) => operation.spanName)
			const linked = facts.linkedIssues.map((issue) => issue.fingerprintHash)
			const [before, after, linkedBefore, linkedAfter, fresh, arriving] = yield* Effect.all(
				[
					spanNames.length === 0
						? Effect.succeed([])
						: telemetry.operationsIn(orgId, services, spanNames, deployAt - WINDOW_MS, deployAt),
					spanNames.length === 0
						? Effect.succeed([])
						: telemetry.operationsIn(orgId, services, spanNames, deployAt, deployAt + WINDOW_MS),
					telemetry.issueCountsIn(orgId, linked, deployAt - WINDOW_MS, deployAt),
					telemetry.issueCountsIn(orgId, linked, deployAt, deployAt + WINDOW_MS),
					telemetry.issuesFirstSeenSince(orgId, services, deployAt),
					telemetry.attributeKeysIn(orgId, deployAt, deployAt + WINDOW_MS),
				],
				{ concurrency: 3 },
			)
			const freshCounts = yield* telemetry.issueCountsIn(
				orgId,
				fresh.map((issue) => issue.fingerprintHash),
				deployAt,
				deployAt + WINDOW_MS,
			)
			const hours = POST_MERGE_WINDOW_MINUTES / 60
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
					firstSeenAt: deployAt,
					exact: picked.exact,
				},
				windowMinutes: POST_MERGE_WINDOW_MINUTES,
				operations: compared,
				newIssues,
				linkedIssues,
				missing,
				verdict: regressed ? "regressed" : "clean",
			})

			// Stored before the post, and only while this examination still holds its lease: one that
			// outlived it lost the row to a later tick, which reports instead. A refused post still
			// leaves the look on the review.
			const won = yield* database.execute((db) =>
				db
					.update(prReviews)
					.set({
						postMergeStatus: "reported",
						postMergeAfter: null,
						postMergeJson: report,
						updatedAt: msToDate(nowMs),
					})
					.where(
						and(
							eq(prReviews.id, row.id),
							eq(prReviews.postMergeStatus, "waiting"),
							eq(prReviews.postMergeAfter, msToDate(leaseUntilMs)),
						),
					)
					.returning({ id: prReviews.id }),
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

		const postComment = (orgId: OrgId, row: typeof prReviews.$inferSelect, body: string) =>
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
				const nowMs = yield* Clock.currentTimeMillis
				const due = yield* database.execute((db) =>
					db
						.select()
						.from(prReviews)
						.where(
							and(
								eq(prReviews.postMergeStatus, "waiting"),
								lte(prReviews.postMergeAfter, msToDate(nowMs)),
							),
						)
						.orderBy(asc(prReviews.postMergeAfter))
						.limit(TICK_LIMIT),
				)
				const outcomes = yield* Effect.forEach(
					due,
					(row) =>
						Effect.gen(function* () {
							const leaseUntilMs = nowMs + CLAIM_MS
							// Claimed first: an overlapping tick that read the same row finds it leased and
							// skips it, so the follow-up is posted once.
							const claimed = yield* database.execute((db) =>
								db
									.update(prReviews)
									.set({ postMergeAfter: msToDate(leaseUntilMs) })
									.where(
										and(
											eq(prReviews.id, row.id),
											eq(prReviews.postMergeStatus, "waiting"),
											lte(prReviews.postMergeAfter, msToDate(nowMs)),
										),
									)
									.returning({ id: prReviews.id }),
							)
							if (claimed.length === 0) return "skipped" as const
							return yield* examine(row, nowMs, leaseUntilMs)
						}).pipe(
							Effect.map((outcome): Outcome | "failed" | "skipped" => outcome),
							Effect.catchCause((cause) => {
								const mergedAtMs = dateToMs(row.mergedAt) ?? nowMs
								// A read that keeps failing is given up with the rest, never read as clean.
								const giveUp = nowMs - mergedAtMs > POST_MERGE_GIVE_UP_MS
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
											? settle(
													row.orgId,
													row.id,
													"failed",
													{ postMergeAfter: null },
													nowMs,
												)
											: later(row.orgId, row.id, nowMs + POST_MERGE_RETRY_MS, nowMs)
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
