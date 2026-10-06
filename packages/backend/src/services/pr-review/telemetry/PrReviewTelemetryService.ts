/**
 * The organization's telemetry, read for one pull request: what it emits, which alerts and
 * dashboards read it, which errors are open, and how production behaved after the merge shipped.
 *
 * The review's reads are best effort and bounded: a review that cannot reach the warehouse reviews
 * the diff as before, without these facts. The post-merge reads fail instead, typed, because an
 * empty answer there would read as a clean deploy.
 */
import {
	GitCommitSha,
	type OrgId,
	type PrReviewTelemetry,
	type PullRequestFile,
	type VcsRepositoryId,
} from "@maple/domain/http"
import { alertRules, dashboards, errorIssues, vcsCommits } from "@maple/db"
import { CH } from "@maple/query-engine"
import { and, desc, eq, gte, inArray, isNull, notInArray } from "drizzle-orm"
import { Context, DateTime, Duration, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { dateToMs } from "@maple/backend/platform/time"
import { systemTenant } from "@maple/backend/services/alerts/system-tenant"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import {
	analyzeTelemetry,
	type CatalogIssue,
	type CatalogOperation,
	DEFAULT_BYTES_PER_LOG_RECORD,
	type TelemetryCatalog,
} from "./analyze"
import type { Deployment, WindowStats } from "./post-merge"
import { type ReferenceSource, textsOf } from "./references"

/** The week a change is weighed against: long enough to include a weekly job, short enough to be today. */
export const TELEMETRY_WINDOW_DAYS = 7
/** How recently an issue must have occurred to count as open for the review. */
const OPEN_ISSUE_WINDOW = Duration.days(14)

/** A deployed version's first-seen time, decoded where the warehouse string enters. */
const decodeFirstSeen = Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)

/** Issues no longer anyone's problem. */
const CLOSED_STATES = ["done", "cancelled", "wontfix"] as const
const ISSUE_SCAN_LIMIT = 500
const SOURCE_SCAN_LIMIT = 500

export class PrReviewTelemetryReadError extends Schema.TaggedError<PrReviewTelemetryReadError>()(
	"@maple/backend/services/pr-review/PrReviewTelemetryReadError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

export interface PrReviewTelemetryServiceApi {
	/** The pull request's diff read against the last week of production. */
	readonly analyze: (
		orgId: OrgId,
		files: ReadonlyArray<PullRequestFile>,
	) => Effect.Effect<PrReviewTelemetry | undefined>
	/**
	 * Versions of these services that first reported since `since`, oldest first; with no services,
	 * every service of the organization.
	 */
	readonly deploymentsSince: (
		orgId: OrgId,
		services: ReadonlyArray<string>,
		since: DateTime.Utc,
		now: DateTime.Utc,
	) => Effect.Effect<ReadonlyArray<Deployment>, PrReviewTelemetryReadError>
	/** When each known commit of a repository was made, for telling an older deploy from a newer one. */
	readonly commitTimes: (
		orgId: OrgId,
		repositoryId: VcsRepositoryId,
		shas: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyMap<string, DateTime.Utc>, PrReviewTelemetryReadError>
	/** Per-operation traffic in one window, minute-exact. */
	readonly operationsIn: (
		orgId: OrgId,
		services: ReadonlyArray<string>,
		spanNames: ReadonlyArray<string>,
		start: DateTime.Utc,
		end: DateTime.Utc,
	) => Effect.Effect<ReadonlyArray<WindowStats>, PrReviewTelemetryReadError>
	/** Occurrences per fingerprint in one window. */
	readonly issueCountsIn: (
		orgId: OrgId,
		fingerprintHashes: ReadonlyArray<string>,
		start: DateTime.Utc,
		end: DateTime.Utc,
	) => Effect.Effect<ReadonlyMap<string, number>, PrReviewTelemetryReadError>
	/** Error issues first seen in these services since a moment. */
	readonly issuesFirstSeenSince: (
		orgId: OrgId,
		services: ReadonlyArray<string>,
		since: DateTime.Utc,
	) => Effect.Effect<ReadonlyArray<CatalogIssue>, PrReviewTelemetryReadError>
	/** Attribute keys set at least once in a window. */
	readonly attributeKeysIn: (
		orgId: OrgId,
		start: DateTime.Utc,
		end: DateTime.Utc,
	) => Effect.Effect<ReadonlySet<string>, PrReviewTelemetryReadError>
}

/** A failed read is logged and read as empty: the review goes on without that fact. */
const orEmpty =
	<Empty>(empty: Empty, what: string, orgId: OrgId) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | Empty, never, R> =>
		effect.pipe(
			Effect.timeout("8 seconds"),
			Effect.catchCause((cause) =>
				Effect.logWarning(`[PrReviewTelemetry] could not read ${what}`).pipe(
					Effect.annotateLogs({ orgId, cause: summarizeCause(cause) }),
					Effect.as(empty),
				),
			),
		)

/** A deployed version's commit as the commits table stores it; a placeholder or a tag is skipped. */
const decodeSha = Schema.decodeUnknownOption(GitCommitSha)

/** A post-merge read that failed, as a typed failure the tick retries rather than an empty answer. */
const orFail =
	(what: string) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, PrReviewTelemetryReadError, R> =>
		effect.pipe(
			Effect.timeout("15 seconds"),
			Effect.mapError(
				(cause) => new PrReviewTelemetryReadError({ message: `could not read ${what}`, cause }),
			),
		)

export class PrReviewTelemetryService extends Context.Service<
	PrReviewTelemetryService,
	PrReviewTelemetryServiceApi
>()("@maple/backend/services/pr-review/telemetry/PrReviewTelemetryService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const warehouse = yield* WarehouseQueryService

		// effect-orm formats `DateTime.Utc` bounds itself, floored for second-precision columns.
		const window = (start: DateTime.Utc, end: DateTime.Utc) => ({
			startTime: start,
			endTime: end,
		})

		const catalogFor = Effect.fn("PrReviewTelemetry.catalog")(function* (
			orgId: OrgId,
			now: DateTime.Utc,
		) {
			const tenant = systemTenant(orgId)
			const params = {
				orgId,
				...window(DateTime.subtractDuration(now, Duration.days(TELEMETRY_WINDOW_DAYS)), now),
			}
			const [operations, spanKeys, resourceKeys, metrics, usage] = yield* Effect.all(
				[
					warehouse
						.compiledQuery(tenant, CH.compile(CH.operationTrafficHourlyQuery({}), params), {
							profile: "aggregation",
							context: "prReviewOperationCatalog",
						})
						.pipe(orEmpty([], "operations", orgId)),
					warehouse
						.compiledQuery(
							tenant,
							CH.compile(CH.attributeKeysQuery({ scope: "span", limit: 2_000 }), params),
							{ profile: "aggregation", context: "prReviewSpanAttributeKeys" },
						)
						.pipe(orEmpty([], "span attribute keys", orgId)),
					warehouse
						.compiledQuery(
							tenant,
							CH.compile(CH.attributeKeysQuery({ scope: "resource", limit: 500 }), params),
							{ profile: "aggregation", context: "prReviewResourceAttributeKeys" },
						)
						.pipe(orEmpty([], "resource attribute keys", orgId)),
					warehouse
						.compiledQuery(tenant, CH.compile(CH.listMetricsQuery({ limit: 2_000 }), params), {
							profile: "aggregation",
							context: "prReviewMetricCatalog",
						})
						.pipe(orEmpty([], "metrics", orgId)),
					warehouse
						.compiledQuery(
							tenant,
							CH.compile(CH.serviceUsageQuery({}), params, {
								rowSchema: CH.serviceUsageRowSchema,
							}),
							{ profile: "aggregation", context: "prReviewServiceUsage" },
						)
						.pipe(orEmpty([], "ingest usage", orgId)),
				],
				{ concurrency: "unbounded" },
			)
			const logCount = usage.reduce((sum, row) => sum + row.totalLogCount, 0)
			const logBytes = usage.reduce((sum, row) => sum + row.totalLogSizeBytes, 0)
			const attributeKeys = [...spanKeys, ...resourceKeys].reduce(
				(keys, row) => keys.set(row.attributeKey, (keys.get(row.attributeKey) ?? 0) + row.usageCount),
				new Map<string, number>(),
			)
			const catalog: TelemetryCatalog = {
				windowDays: TELEMETRY_WINDOW_DAYS,
				operations: operations.map((row): CatalogOperation => ({
					service: row.serviceName,
					spanName: row.spanName,
					count: row.spanCount,
					errorCount: row.errorCount,
					p95Ms: row.p95DurationMs,
				})),
				attributeKeys,
				metricNames: new Map(metrics.map((row) => [row.metricName, row.dataPointCount] as const)),
				bytesPerLogRecord: logCount > 0 ? logBytes / logCount : DEFAULT_BYTES_PER_LOG_RECORD,
			}
			return catalog
		})

		const referenceSources = Effect.fn("PrReviewTelemetry.referenceSources")(function* (orgId: OrgId) {
			const [rules, boards] = yield* Effect.all(
				[
					database.execute((db) =>
						db
							.select({
								id: alertRules.id,
								name: alertRules.name,
								querySpecJson: alertRules.querySpecJson,
								queryBuilderDraftJson: alertRules.queryBuilderDraftJson,
								rawQuerySql: alertRules.rawQuerySql,
								groupBy: alertRules.groupBy,
							})
							.from(alertRules)
							.where(and(eq(alertRules.orgId, orgId), eq(alertRules.enabled, true)))
							.limit(SOURCE_SCAN_LIMIT),
					),
					database.execute((db) =>
						db
							.select({
								id: dashboards.id,
								name: dashboards.name,
								payloadJson: dashboards.payloadJson,
							})
							.from(dashboards)
							.where(eq(dashboards.orgId, orgId))
							.orderBy(desc(dashboards.updatedAt))
							.limit(SOURCE_SCAN_LIMIT),
					),
				],
				{ concurrency: "unbounded" },
			)
			return [
				...rules.map((rule): ReferenceSource => ({
					kind: "alert",
					id: rule.id,
					name: rule.name,
					texts: textsOf([
						rule.querySpecJson,
						rule.queryBuilderDraftJson,
						rule.rawQuerySql,
						rule.groupBy,
					]),
				})),
				...boards.map((board): ReferenceSource => ({
					kind: "dashboard",
					id: board.id,
					name: board.name,
					texts: textsOf(board.payloadJson),
				})),
			]
		})

		const openIssues = Effect.fn("PrReviewTelemetry.openIssues")(function* (
			orgId: OrgId,
			now: DateTime.Utc,
		) {
			const rows = yield* database.execute((db) =>
				db
					.select({
						id: errorIssues.id,
						fingerprintHash: errorIssues.fingerprintHash,
						serviceName: errorIssues.serviceName,
						exceptionType: errorIssues.exceptionType,
						errorLabel: errorIssues.errorLabel,
						exceptionMessage: errorIssues.exceptionMessage,
						topFrame: errorIssues.topFrame,
						occurrenceCount: errorIssues.occurrenceCount,
						lastSeenAt: errorIssues.lastSeenAt,
					})
					.from(errorIssues)
					.where(
						and(
							eq(errorIssues.orgId, orgId),
							eq(errorIssues.kind, "error"),
							isNull(errorIssues.archivedAt),
							notInArray(errorIssues.workflowState, [...CLOSED_STATES]),
							gte(
								errorIssues.lastSeenAt,
								DateTime.toDateUtc(DateTime.subtractDuration(now, OPEN_ISSUE_WINDOW)),
							),
						),
					)
					.orderBy(desc(errorIssues.lastSeenAt))
					.limit(ISSUE_SCAN_LIMIT),
			)
			return rows.map(toCatalogIssue)
		})

		const analyze: PrReviewTelemetryServiceApi["analyze"] = (orgId, files) =>
			Effect.gen(function* () {
				const now = yield* DateTime.now
				const [catalog, sources, issues] = yield* Effect.all(
					[
						catalogFor(orgId, now),
						referenceSources(orgId).pipe(orEmpty([], "alerts and dashboards", orgId)),
						openIssues(orgId, now).pipe(orEmpty([], "open issues", orgId)),
					],
					{ concurrency: "unbounded" },
				)
				const telemetry = analyzeTelemetry({ files, catalog, sources, issues })
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.pr_review.telemetry.operations": catalog.operations.length,
					"maple.pr_review.telemetry.sources": sources.length,
					"maple.pr_review.telemetry.contract_breaks": telemetry.contractBreaks.length,
					"maple.pr_review.telemetry.hot_files": telemetry.hotFiles.length,
					"maple.pr_review.telemetry.linked_issues": telemetry.linkedIssues.length,
					"maple.pr_review.telemetry.cost_notes": telemetry.costNotes.length,
				})
				// Nothing to say: the kickoff and the comment stay as they were.
				return catalog.operations.length === 0 && sources.length === 0 && issues.length === 0
					? undefined
					: telemetry
			}).pipe(
				Effect.withSpan("PrReviewTelemetryService.analyze"),
				Effect.catchCause((cause) =>
					Effect.logWarning("[PrReviewTelemetry] analysis failed; reviewing without it").pipe(
						Effect.annotateLogs({ orgId, cause: summarizeCause(cause) }),
						Effect.as(undefined),
					),
				),
			)

		const deploymentsSince: PrReviewTelemetryServiceApi["deploymentsSince"] = (
			orgId,
			services,
			since,
			now,
		) =>
			Effect.forEach(
				services.length === 0 ? [undefined] : services,
				(serviceName) =>
					warehouse.compiledQuery(
						systemTenant(orgId),
						CH.compile(
							CH.serviceDeploymentsQuery({ serviceName, minutePrecision: true, limit: 50 }),
							{ orgId, ...window(DateTime.subtractDuration(since, Duration.hours(1)), now) },
							{ rowSchema: CH.serviceDeploymentsRowSchema },
						),
						{ profile: "aggregation", context: "prReviewDeployments" },
					),
				{ concurrency: 4 },
			).pipe(
				// Each version's first-seen time decoded at the warehouse boundary: a malformed one fails
				// the read, which the tick retries, rather than dropping the deploy.
				Effect.flatMap((perService) =>
					Effect.forEach(perService.flat(), (row) =>
						decodeFirstSeen(row.firstSeen).pipe(
							Effect.map((firstSeen): Deployment => ({
								service: row.serviceName,
								environment: row.environment,
								commitSha: row.commitSha,
								firstSeen,
							})),
						),
					),
				),
				Effect.map((versions) =>
					versions
						.filter((version) => DateTime.isGreaterThanOrEqualTo(version.firstSeen, since))
						.sort((a, b) => DateTime.Order(a.firstSeen, b.firstSeen)),
				),
				orFail("deployments"),
				Effect.withSpan("PrReviewTelemetryService.deploymentsSince"),
			)

		const operationsIn: PrReviewTelemetryServiceApi["operationsIn"] = (
			orgId,
			services,
			spanNames,
			start,
			end,
		) =>
			warehouse
				.compiledQuery(
					systemTenant(orgId),
					CH.compile(
						CH.operationTrafficMinutelyQuery({ serviceNames: services, spanNames, limit: 200 }),
						{ orgId, ...window(start, end) },
					),
					{ profile: "aggregation", context: "prReviewOperationWindow" },
				)
				.pipe(
					Effect.map((rows) =>
						rows.map((row) => ({
							service: row.serviceName,
							spanName: row.spanName,
							count: row.spanCount,
							errorCount: row.errorCount,
							p95Ms: row.p95DurationMs,
						})),
					),
					orFail("operation window"),
				)

		const issueCountsIn: PrReviewTelemetryServiceApi["issueCountsIn"] = (
			orgId,
			fingerprintHashes,
			start,
			end,
		) =>
			fingerprintHashes.length === 0
				? Effect.succeed(new Map())
				: warehouse
						.compiledQuery(
							systemTenant(orgId),
							CH.compile(
								CH.errorIssuesQuery({ fingerprintHashes, limit: fingerprintHashes.length }),
								{ orgId, ...window(start, end) },
							),
							{ profile: "aggregation", context: "prReviewIssueCounts" },
						)
						.pipe(
							Effect.map(
								(rows) =>
									new Map(rows.map((row) => [row.fingerprintHash, row.count] as const)),
							),
							orFail("issue counts"),
						)

		const issuesFirstSeenSince: PrReviewTelemetryServiceApi["issuesFirstSeenSince"] = (
			orgId,
			services,
			since,
		) =>
			services.length === 0
				? Effect.succeed([])
				: database
						.execute((db) =>
							db
								.select({
									id: errorIssues.id,
									fingerprintHash: errorIssues.fingerprintHash,
									serviceName: errorIssues.serviceName,
									exceptionType: errorIssues.exceptionType,
									errorLabel: errorIssues.errorLabel,
									exceptionMessage: errorIssues.exceptionMessage,
									topFrame: errorIssues.topFrame,
									occurrenceCount: errorIssues.occurrenceCount,
									lastSeenAt: errorIssues.lastSeenAt,
								})
								.from(errorIssues)
								.where(
									and(
										eq(errorIssues.orgId, orgId),
										eq(errorIssues.kind, "error"),
										inArray(errorIssues.serviceName, [...services]),
										gte(errorIssues.firstSeenAt, DateTime.toDateUtc(since)),
									),
								)
								.orderBy(desc(errorIssues.occurrenceCount))
								.limit(20),
						)
						.pipe(
							Effect.map((rows) => rows.map(toCatalogIssue)),
							orFail("new issues"),
						)

		const attributeKeysIn: PrReviewTelemetryServiceApi["attributeKeysIn"] = (orgId, start, end) =>
			Effect.all(
				(["span", "resource"] as const).map((scope) =>
					warehouse.compiledQuery(
						systemTenant(orgId),
						CH.compile(CH.attributeKeysQuery({ scope, limit: 2_000 }), {
							orgId,
							...window(start, end),
						}),
						{ profile: "aggregation", context: "prReviewAttributeKeysWindow" },
					),
				),
				{ concurrency: "unbounded" },
			).pipe(
				Effect.map((scopes) => new Set(scopes.flat().map((row) => row.attributeKey))),
				orFail("attribute keys"),
			)

		const commitTimes: PrReviewTelemetryServiceApi["commitTimes"] = (orgId, repositoryId, shas) =>
			shas.length === 0
				? Effect.succeed(new Map())
				: database
						.execute((db) =>
							db
								.select({ sha: vcsCommits.sha, committedAt: vcsCommits.committedAt })
								.from(vcsCommits)
								.where(
									and(
										eq(vcsCommits.orgId, orgId),
										eq(vcsCommits.repositoryId, repositoryId),
										inArray(
											vcsCommits.sha,
											shas.flatMap((sha) =>
												Option.toArray(decodeSha(sha.toLowerCase())),
											),
										),
									),
								),
						)
						.pipe(
							Effect.map(
								(rows) =>
									new Map(
										rows.map(
											(row) =>
												[
													row.sha.toLowerCase(),
													DateTime.fromDateUnsafe(row.committedAt),
												] as const,
										),
									),
							),
							orFail("commit times"),
						)

		return {
			analyze,
			commitTimes,
			deploymentsSince,
			operationsIn,
			issueCountsIn,
			issuesFirstSeenSince,
			attributeKeysIn,
		} satisfies PrReviewTelemetryServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}

const toCatalogIssue = (row: {
	readonly id: string
	readonly fingerprintHash: string
	readonly serviceName: string
	readonly exceptionType: string
	readonly errorLabel: string
	readonly exceptionMessage: string
	readonly topFrame: string
	readonly occurrenceCount: number
	readonly lastSeenAt: Date
}): CatalogIssue => ({
	id: row.id,
	fingerprintHash: row.fingerprintHash,
	title: (row.errorLabel || `${row.exceptionType}: ${row.exceptionMessage}`).slice(0, 200),
	service: row.serviceName,
	topFrame: row.topFrame,
	occurrences: row.occurrenceCount,
	lastSeenAt: dateToMs(row.lastSeenAt) ?? 0,
})
