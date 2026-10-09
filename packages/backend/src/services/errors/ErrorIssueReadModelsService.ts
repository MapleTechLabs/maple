import {
	type ActorId,
	ErrorIncidentDocument,
	ErrorIncidentsListResponse,
	ErrorIssueDetailResponse,
	ErrorIssueDocument,
	type ErrorIssueId,
	ErrorIssueNotFoundError,
	ErrorIssueSampleTrace,
	ErrorIssuesListResponse,
	ErrorIssueTimeseriesPoint,
	ErrorIssueEnvironment,
	ErrorPersistenceError,
	IssueListCursor,
	type IssueListCursorFields,
	IssueSeverityListCursor,
	type IssueSeverityListCursorFields,
	type IssueKind,
	type IssueSeverity,
	type OrgId,
	RoleName,
	UserId as UserIdSchema,
	type WorkflowState,
	type WarehouseReadError,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { ErrorIncidents, type ErrorIncidentRow, ErrorIssues } from "@maple/db/tables"
import { CH, formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { Clock, Context, DateTime, Effect, Layer, Match, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { ErrorIssueWorkflowService } from "./ErrorIssueWorkflowService"
import { makeErrorDatabaseExecute } from "./error-persistence"

const decodeErrorIssueIdSync = Schema.decodeUnknownSync(ErrorIssueDocument.fields.id)
const encodeIssueListCursor = Schema.encodeSync(IssueListCursor)
const encodeIssueSeverityListCursorRaw = Schema.encodeSync(IssueSeverityListCursor)
const encodeIssueSeverityListCursor = (fields: IssueSeverityListCursorFields): string =>
	`sev_${encodeIssueSeverityListCursorRaw(fields)}`
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(ErrorIssueDocument.fields.firstSeenAt)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)

const DEFAULT_DETAIL_WINDOW_MS = 24 * 60 * 60 * 1000
/** Fallback fingerprint-scan window for the issue list's env filter when the
 * caller provides no time range (30d ≈ the issue-list retention horizon). */
const ENV_FINGERPRINT_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const ACTIONABLE_WORKFLOW_STATES: ReadonlyArray<WorkflowState> = [
	"triage",
	// A fix that did not hold is the most actionable state there is; omitting it
	// would hide exactly the issues that most need attention from the open-issue
	// lists and the per-service open counts.
	"regressed",
	"todo",
	"in_progress",
	"in_review",
]

type IssueColumns = PG.ColumnAccessor<typeof ErrorIssues.columns>
type IssueConditions = ($: IssueColumns) => Array<PG.Condition | undefined>

/** Shared SQL ordering expression for the UI's critical-first issue ordering. */
const issueSeverityOrder = ($: IssueColumns) =>
	PG.caseWhen(
		[
			[$.severity.eq("critical"), PG.lit(0)],
			[$.severity.eq("high"), PG.lit(1)],
			[$.severity.eq("medium"), PG.lit(2)],
			[$.severity.eq("low"), PG.lit(3)],
		],
		PG.lit(4),
	)

const severitySortRank = (severity: IssueSeverity | null): number =>
	Match.value(severity).pipe(
		Match.when("critical", () => 0),
		Match.when("high", () => 1),
		Match.when("medium", () => 2),
		Match.when("low", () => 3),
		Match.when(null, () => 4),
		Match.exhaustive,
	)

export interface IssueListFilters {
	readonly workflowState?: WorkflowState
	readonly severity?: IssueSeverity | "unset"
	readonly kind?: IssueKind
	readonly service?: string
	/** Exact exception type or display label. */
	readonly exceptionType?: string
	/** Case-insensitive substring of the type, message, label or service. */
	readonly search?: string
	/** Restrict to these fingerprint hashes (volume-ranked lists ask for an
	 *  explicit set). An empty array matches nothing, as it should. */
	readonly fingerprintHashes?: ReadonlyArray<string>
	/** Only issues whose fingerprint the warehouse observed in this
	 * deployment environment (within startTime/endTime, defaulting to the
	 * trailing 30d). Costs one warehouse round-trip; excludes alert-kind
	 * issues (synthetic fingerprints carry no environment). */
	readonly deploymentEnv?: string
	readonly assignedActorId?: ActorId
	readonly includeArchived?: boolean
	readonly startTime?: string
	readonly endTime?: string
	/** First seen or last regressed at or after this instant. */
	readonly introducedAfter?: string
	readonly actionable?: boolean
}

export interface ErrorIssueReadModelsPublicApi {
	readonly listIssues: (
		orgId: OrgId,
		opts: IssueListFilters & {
			readonly limit?: number
			readonly cursor?: IssueListCursorFields | IssueSeverityListCursorFields
			readonly sort?: "last_seen" | "severity"
		},
	) => Effect.Effect<ErrorIssuesListResponse, ErrorPersistenceError | WarehouseReadError>
	/** How many issues match the list filters, across every page. */
	readonly countIssues: (
		orgId: OrgId,
		opts: IssueListFilters,
	) => Effect.Effect<number, ErrorPersistenceError | WarehouseReadError>
	/** Fleet-level open (actionable-state) error-issue counts grouped by service. */
	readonly countOpenIssuesByService: (
		orgId: OrgId,
	) => Effect.Effect<
		ReadonlyArray<{ readonly serviceName: string; readonly openCount: number }>,
		ErrorPersistenceError
	>
	readonly getIssue: (
		orgId: OrgId,
		issueId: ErrorIssueId,
		opts: {
			readonly startTime?: string
			readonly endTime?: string
			readonly bucketSeconds?: number
			readonly sampleLimit?: number
		},
	) => Effect.Effect<
		ErrorIssueDetailResponse,
		ErrorPersistenceError | ErrorIssueNotFoundError | WarehouseReadError
	>
	readonly listIssueIncidents: (
		orgId: OrgId,
		issueId: ErrorIssueId,
	) => Effect.Effect<ErrorIncidentsListResponse, ErrorPersistenceError | ErrorIssueNotFoundError>
	readonly listOpenIncidents: (
		orgId: OrgId,
	) => Effect.Effect<ErrorIncidentsListResponse, ErrorPersistenceError>
}

export type ErrorIssueReadModelsServiceApi = ErrorIssueReadModelsPublicApi

const make: Effect.Effect<
	ErrorIssueReadModelsServiceApi,
	never,
	Database | WarehouseQueryService | ErrorIssueWorkflowService
> = Effect.gen(function* () {
	const database = yield* Database
	const warehouse = yield* WarehouseQueryService
	const workflow = yield* ErrorIssueWorkflowService
	const dbExecute = makeErrorDatabaseExecute(database, "ErrorIssueReadModelsService")

	const systemTenant = (orgId: OrgId): TenantContext => ({
		orgId,
		userId: decodeUserIdSync("system-errors"),
		roles: [decodeRoleNameSync("root")],
		authMode: "self_hosted",
	})

	const rowToIncident = (row: ErrorIncidentRow) =>
		new ErrorIncidentDocument({
			id: row.id,
			issueId: row.issueId,
			status: row.status,
			reason: row.reason,
			firstTriggeredAt: decodeIsoDateTimeStringSync(new Date(row.firstTriggeredAt).toISOString()),
			lastTriggeredAt: decodeIsoDateTimeStringSync(new Date(row.lastTriggeredAt).toISOString()),
			resolvedAt:
				row.resolvedAt == null
					? null
					: decodeIsoDateTimeStringSync(new Date(row.resolvedAt).toISOString()),
			occurrenceCount: row.occurrenceCount,
		})

	/** Fingerprints the warehouse saw in one deployment env, over the list's window (30d by default). */
	const envFingerprintHashes = (orgId: OrgId, deploymentEnv: string, opts: IssueListFilters) =>
		Effect.gen(function* () {
			const nowMs = yield* Clock.currentTimeMillis
			const endMs = opts.endTime ? parseWarehouseDateTime(opts.endTime) : Number.NaN
			const startMs = opts.startTime ? parseWarehouseDateTime(opts.startTime) : Number.NaN
			const scanEndMs = Number.isFinite(endMs) ? endMs : nowMs
			const scanStartMs = Number.isFinite(startMs)
				? startMs
				: scanEndMs - ENV_FINGERPRINT_DEFAULT_WINDOW_MS
			const compiled = CH.compile(
				CH.errorFingerprintsQuery({
					services: opts.service ? [opts.service] : undefined,
					deploymentEnvs: [deploymentEnv],
				}),
				{
					orgId,
					startTime: formatWarehouseDateTime(scanStartMs),
					endTime: formatWarehouseDateTime(scanEndMs),
				},
			)
			const fingerprintRows = yield* warehouse.compiledQuery(systemTenant(orgId), compiled, {
				context: "errorIssueEnvFingerprints",
			})
			return fingerprintRows.map((row) => row.fingerprintHash).filter((hash) => hash.length > 0)
		})

	/** The filter half of the issue list, shared by the page and its count. `undefined` = matches nothing. */
	const issueListConditions = Effect.fn("ErrorsService.issueListConditions")(function* (
		orgId: OrgId,
		opts: IssueListFilters,
	) {
		// `""` is a real filter (raw spans without a deployment env), so check
		// for undefined rather than truthiness.
		const envHashes =
			opts.deploymentEnv === undefined
				? undefined
				: yield* envFingerprintHashes(orgId, opts.deploymentEnv, opts)
		if (envHashes !== undefined && envHashes.length === 0) return undefined

		const finiteMs = (value: string | undefined) => {
			const ms = value ? parseWarehouseDateTime(value) : Number.NaN
			return Number.isFinite(ms) ? ms : undefined
		}
		const endMs = finiteMs(opts.endTime)
		const startMs = finiteMs(opts.startTime)
		const sinceMs = finiteMs(opts.introducedAfter)
		const pattern = opts.search ? `%${opts.search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : undefined
		const conditions: IssueConditions = ($) => [
			$.orgId.eq(orgId),
			opts.workflowState ? $.workflowState.eq(opts.workflowState) : undefined,
			opts.actionable ? $.workflowState.in_(...ACTIONABLE_WORKFLOW_STATES) : undefined,
			opts.severity === "unset"
				? $.severity.isNull()
				: opts.severity
					? $.severity.eq(opts.severity)
					: undefined,
			opts.kind ? $.kind.eq(opts.kind) : undefined,
			opts.service ? $.serviceName.eq(opts.service) : undefined,
			opts.exceptionType
				? PG.or($.exceptionType.eq(opts.exceptionType), $.errorLabel.eq(opts.exceptionType))
				: undefined,
			pattern === undefined
				? undefined
				: PG.or(
						$.exceptionType.ilike(pattern),
						$.exceptionMessage.ilike(pattern),
						$.errorLabel.ilike(pattern),
						$.serviceName.ilike(pattern),
					),
			opts.fingerprintHashes === undefined
				? undefined
				: $.fingerprintHash.in_(...opts.fingerprintHashes),
			envHashes === undefined ? undefined : $.fingerprintHash.in_(...envHashes),
			opts.assignedActorId ? $.assignedActorId.eq(opts.assignedActorId) : undefined,
			opts.includeArchived ? undefined : $.archivedAt.isNull(),
			endMs === undefined ? undefined : $.firstSeenAt.lt(endMs),
			startMs === undefined ? undefined : $.lastSeenAt.gt(startMs),
			sinceMs === undefined
				? undefined
				: PG.or($.firstSeenAt.gte(sinceMs), $.lastRegressedAt.gte(sinceMs)),
		]
		return conditions
	})

	const listIssues: ErrorIssueReadModelsServiceApi["listIssues"] = Effect.fn("ErrorsService.listIssues")(
		function* (orgId, opts) {
			const sort = opts.sort ?? "last_seen"
			yield* Effect.annotateCurrentSpan({
				orgId,
				workflowState: opts.workflowState ?? "all",
				limit: opts.limit ?? 100,
				sort,
				...(opts.deploymentEnv ? { deploymentEnv: opts.deploymentEnv } : undefined),
			})
			const base = yield* issueListConditions(orgId, opts)
			if (base === undefined) {
				yield* Effect.annotateCurrentSpan({ issueCount: 0, hasMore: false })
				return new ErrorIssuesListResponse({ issues: [] })
			}
			const cursor = opts.cursor
			const keyset =
				cursor === undefined
					? undefined
					: ($: IssueColumns) => {
							const seenBefore = PG.or(
								$.lastSeenAt.lt(cursor.lastSeenAt),
								PG.and($.lastSeenAt.eq(cursor.lastSeenAt), $.id.lt(cursor.id)),
							)
							return sort === "severity" && "severityRank" in cursor
								? PG.or(
										issueSeverityOrder($).gt(cursor.severityRank),
										PG.and(issueSeverityOrder($).eq(cursor.severityRank), seenBefore),
									)
								: seenBefore
						}

			const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
			const fetched = yield* dbExecute((db) => {
				const query = PG.from(ErrorIssues)
					.select()
					.where(($) => [...base($), keyset?.($)])
				return db.orm.run(
					(sort === "severity"
						? query.orderBy(($) => [
								[issueSeverityOrder($), "asc"],
								[$.lastSeenAt, "desc"],
								[$.id, "desc"],
							])
						: query.orderBy(($) => [
								[$.lastSeenAt, "desc"],
								[$.id, "desc"],
							])
					).limit(limit + 1),
				)
			})
			const hasMore = fetched.length > limit
			const rows = hasMore ? fetched.slice(0, limit) : fetched
			const issues = yield* workflow.hydrateIssueRows(orgId, rows)

			yield* Effect.annotateCurrentSpan({ issueCount: issues.length, hasMore })
			const lastRow = rows.at(-1)
			const nextCursor =
				hasMore && lastRow
					? sort === "severity"
						? encodeIssueSeverityListCursor({
								severityRank: severitySortRank(lastRow.severity),
								lastSeenAt: lastRow.lastSeenAt,
								id: decodeErrorIssueIdSync(lastRow.id),
							})
						: encodeIssueListCursor({
								lastSeenAt: lastRow.lastSeenAt,
								id: decodeErrorIssueIdSync(lastRow.id),
							})
					: undefined
			return new ErrorIssuesListResponse(nextCursor === undefined ? { issues } : { issues, nextCursor })
		},
	)

	const countIssues: ErrorIssueReadModelsServiceApi["countIssues"] = Effect.fn("ErrorsService.countIssues")(
		function* (orgId, opts) {
			const conditions = yield* issueListConditions(orgId, opts)
			if (conditions === undefined) return 0
			const rows = yield* dbExecute((db) =>
				db.orm.run(
					PG.from(ErrorIssues)
						.select(() => ({ total: PG.count() }))
						.where(conditions),
				),
			)
			const total = rows[0]?.total ?? 0
			yield* Effect.annotateCurrentSpan({ orgId, issueTotal: total })
			return total
		},
	)

	const countOpenIssuesByService: ErrorIssueReadModelsServiceApi["countOpenIssuesByService"] = Effect.fn(
		"ErrorsService.countOpenIssuesByService",
	)(function* (orgId) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const rows = yield* dbExecute((db) =>
			db.orm.run(
				PG.from(ErrorIssues)
					.select(($) => ({ serviceName: $.serviceName, openCount: PG.count() }))
					.where(($) => [
						$.orgId.eq(orgId),
						$.workflowState.in_(...ACTIONABLE_WORKFLOW_STATES),
						$.kind.eq("error"),
						$.archivedAt.isNull(),
					])
					.groupBy("serviceName"),
			),
		)
		const counts = rows.filter((row) => row.serviceName !== "")
		yield* Effect.annotateCurrentSpan({ serviceCount: counts.length })
		return counts
	})

	const getIssue: ErrorIssueReadModelsServiceApi["getIssue"] = Effect.fn("ErrorsService.getIssue")(
		function* (orgId, issueId, opts) {
			yield* Effect.annotateCurrentSpan({ orgId, issueId })
			const issueRow = yield* workflow.requireIssue(orgId, issueId)
			const endMs = opts.endTime ? parseWarehouseDateTime(opts.endTime) : yield* Clock.currentTimeMillis
			const startMs = opts.startTime
				? parseWarehouseDateTime(opts.startTime)
				: endMs - DEFAULT_DETAIL_WINDOW_MS
			const bucketSeconds = opts.bucketSeconds ?? 3600
			const sampleLimit = opts.sampleLimit ?? 25
			const tenant = systemTenant(orgId)
			const isErrorKind = issueRow.kind === "error"

			const timeseriesCompiled = CH.compile(CH.errorIssueTimeseriesQuery(), {
				orgId,
				fingerprintHash: issueRow.fingerprintHash,
				startTime: formatWarehouseDateTime(startMs),
				endTime: formatWarehouseDateTime(endMs),
				bucketSeconds,
			})
			const timeseriesEffect = isErrorKind
				? warehouse.compiledQuery(tenant, timeseriesCompiled, {
						context: "errorIssueTimeseries",
					})
				: Effect.succeed([])

			const samplesCompiled = CH.compile(CH.errorIssueSampleTracesQuery({ limit: sampleLimit }), {
				orgId,
				fingerprintHash: issueRow.fingerprintHash,
				startTime: formatWarehouseDateTime(startMs),
				endTime: formatWarehouseDateTime(endMs),
			})
			const samplesEffect = isErrorKind
				? warehouse.compiledQuery(tenant, samplesCompiled, {
						context: "errorIssueSampleTraces",
					})
				: Effect.succeed([])

			const environmentsCompiled = CH.compile(CH.errorIssueEnvironmentsQuery(), {
				orgId,
				fingerprintHash: issueRow.fingerprintHash,
				startTime: formatWarehouseDateTime(startMs),
				endTime: formatWarehouseDateTime(endMs),
			})
			const environmentsEffect = isErrorKind
				? warehouse.compiledQuery(tenant, environmentsCompiled, {
						context: "errorIssueEnvironments",
					})
				: Effect.succeed([])

			const incidentsEffect = dbExecute((db) =>
				db.orm.run(
					PG.from(ErrorIncidents)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.issueId.eq(issueId)])
						.orderBy(["lastTriggeredAt", "desc"])
						.limit(50),
				),
			)

			const [timeseriesRows, sampleRows, environmentRows, incidentRows] = yield* Effect.all(
				[timeseriesEffect, samplesEffect, environmentsEffect, incidentsEffect],
				{ concurrency: 4 },
			)
			const issue = (yield* workflow.hydrateIssueRows(orgId, [issueRow]))[0]!
			const timeseries = timeseriesRows.map(
				(row) =>
					new ErrorIssueTimeseriesPoint({
						bucket: decodeIsoDateTimeStringSync(DateTime.formatIso(row.bucket)),
						count: row.count,
					}),
			)
			const sampleTraces = sampleRows.map(
				(row) =>
					new ErrorIssueSampleTrace({
						traceId: row.traceId,
						spanId: row.spanId,
						serviceName: row.serviceName,
						timestamp: decodeIsoDateTimeStringSync(DateTime.formatIso(row.timestamp)),
						exceptionMessage: row.exceptionMessage,
						durationMicros: row.durationMicros,
					}),
			)

			const environments = environmentRows.map(
				(row) => new ErrorIssueEnvironment({ name: row.name, count: row.count }),
			)

			return new ErrorIssueDetailResponse({
				issue,
				timeseries,
				sampleTraces,
				incidents: incidentRows.map(rowToIncident),
				environments,
			})
		},
	)

	const listIssueIncidents: ErrorIssueReadModelsServiceApi["listIssueIncidents"] = Effect.fn(
		"ErrorsService.listIssueIncidents",
	)(function* (orgId, issueId) {
		yield* Effect.annotateCurrentSpan({ orgId, issueId })
		yield* workflow.requireIssue(orgId, issueId)
		const rows = yield* dbExecute((db) =>
			db.orm.run(
				PG.from(ErrorIncidents)
					.select()
					.where(($) => [$.orgId.eq(orgId), $.issueId.eq(issueId)])
					.orderBy(["lastTriggeredAt", "desc"])
					.limit(200),
			),
		)
		yield* Effect.annotateCurrentSpan("incidentCount", rows.length)
		return new ErrorIncidentsListResponse({
			incidents: rows.map(rowToIncident),
		})
	})

	const listOpenIncidents: ErrorIssueReadModelsServiceApi["listOpenIncidents"] = Effect.fn(
		"ErrorsService.listOpenIncidents",
	)(function* (orgId) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const rows = yield* dbExecute((db) =>
			db.orm.run(
				PG.from(ErrorIncidents)
					.select()
					.where(($) => [$.orgId.eq(orgId), $.status.eq("open")])
					.orderBy(["lastTriggeredAt", "desc"])
					.limit(500),
			),
		)
		yield* Effect.annotateCurrentSpan("incidentCount", rows.length)
		return new ErrorIncidentsListResponse({
			incidents: rows.map(rowToIncident),
		})
	})

	return ErrorIssueReadModelsService.of({
		listIssues,
		countIssues,
		countOpenIssuesByService,
		getIssue,
		listIssueIncidents,
		listOpenIncidents,
	})
})

export class ErrorIssueReadModelsService extends Context.Service<
	ErrorIssueReadModelsService,
	ErrorIssueReadModelsServiceApi
>()("@maple/api/services/errors/ErrorIssueReadModelsService", { make }) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(WarehouseQueryService.layer, ErrorIssueWorkflowService.layer)),
	)
}
