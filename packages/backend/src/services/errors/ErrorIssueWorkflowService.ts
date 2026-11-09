import { randomUUID } from "node:crypto"
import {
	ActorDocument,
	type ActorId,
	ActorNotFoundError,
	ErrorIssueDocument,
	ErrorIssueEventId as ErrorIssueEventIdSchema,
	ErrorIssueEventDocument,
	ErrorIssueEventsResponse,
	type ErrorIssueEventType,
	type ErrorIssueId,
	ErrorIssueLeaseConflictError,
	ErrorIssueNotFoundError,
	ErrorIssueTransitionError,
	ErrorPersistenceError,
	IssueEscalationId as IssueEscalationIdSchema,
	type IssueSeverity,
	type IssueSeveritySource,
	type OrgId,
	type WorkflowState,
	WORKFLOW_TRANSITIONS,
	CLOSED_WORKFLOW_STATES,
	MACHINE_OWNED_WORKFLOW_STATES,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	Actors,
	AlertIncidents,
	ErrorIncidents,
	ErrorIssues,
	ErrorIssueEvents,
	ErrorIssuePullRequests,
	ErrorIssueStates,
	type ErrorIssueEventInsert,
	type ErrorIssueEventRow,
	type ErrorIssueRow,
	IssueEscalations,
} from "@maple/db/tables"
import { Clock, Context, Effect, Layer, Option, Schema, Array as Arr } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"
import { SYSTEM_ERRORS_AGENT_NAME } from "@maple/backend/services/auth/system-actors"
import { currentTxid, readTxid } from "@maple/backend/platform/electric-txid"
import { transitionRow } from "@maple/backend/platform/transition-row"
import { ErrorActorsService } from "./ErrorActorsService"
import { makeErrorDatabaseExecute } from "./error-persistence"
import { issueFingerprintHashes } from "./issue-fingerprints"
import { escalationDedupeKey, escalationReasonFor } from "./issue-severity"

const StoredJsonRecord = Schema.Record(Schema.String, Schema.Unknown)
type StoredJsonRecord = typeof StoredJsonRecord.Type

const decodeStoredJsonRecord = Schema.decodeUnknownOption(StoredJsonRecord)
const decodeEventIdSync = Schema.decodeUnknownSync(ErrorIssueEventIdSchema)
const decodeIssueEscalationIdSync = Schema.decodeUnknownSync(IssueEscalationIdSchema)
const decodeIssueDateTimeSync = Schema.decodeUnknownSync(ErrorIssueDocument.fields.firstSeenAt)

const DEFAULT_EVENTS_LIMIT = 100
const DEFAULT_LEASE_DURATION_MS = 30 * 60_000

export interface ErrorIssueWorkflowPublicApi {
	readonly heartbeatIssue: (
		orgId: OrgId,
		actorId: ActorId,
		issueId: ErrorIssueId,
	) => Effect.Effect<
		ErrorIssueDocument,
		ErrorPersistenceError | ErrorIssueNotFoundError | ErrorIssueLeaseConflictError
	>
	readonly releaseIssue: (
		orgId: OrgId,
		actorId: ActorId,
		issueId: ErrorIssueId,
		opts?: { readonly transitionTo?: WorkflowState; readonly note?: string },
	) => Effect.Effect<
		ErrorIssueDocument,
		| ErrorPersistenceError
		| ErrorIssueNotFoundError
		| ErrorIssueLeaseConflictError
		| ErrorIssueTransitionError
	>
	readonly assignIssue: (
		orgId: OrgId,
		byActorId: ActorId,
		issueId: ErrorIssueId,
		toActorId: ActorId | null,
	) => Effect.Effect<
		ErrorIssueDocument,
		ErrorPersistenceError | ErrorIssueNotFoundError | ActorNotFoundError
	>
	readonly setSeverity: (
		orgId: OrgId,
		actorId: ActorId,
		issueId: ErrorIssueId,
		severity: IssueSeverity | null,
		opts?: { readonly note?: string; readonly source?: "ai" | "manual" },
	) => Effect.Effect<ErrorIssueDocument, ErrorPersistenceError | ErrorIssueNotFoundError>
	readonly commentOnIssue: (
		orgId: OrgId,
		actorId: ActorId,
		issueId: ErrorIssueId,
		body: string,
		opts?: {
			readonly visibility?: "internal" | "public"
			readonly kind?: "comment" | "agent_note"
		},
	) => Effect.Effect<ErrorIssueEventDocument, ErrorPersistenceError | ErrorIssueNotFoundError>
	readonly listIssueEvents: (
		orgId: OrgId,
		issueId: ErrorIssueId,
		opts?: { readonly limit?: number },
	) => Effect.Effect<ErrorIssueEventsResponse, ErrorPersistenceError | ErrorIssueNotFoundError>
}

/** Per-issue activity rollup carried onto the document for list surfaces. */
export interface IssueActivityRollup {
	readonly commentCount: number
	readonly openPullRequestCount: number
	readonly mergedPullRequestCount: number
}

/** Internal workflow kernel shared with ErrorsService's transitions, claims, fixes, and tick. */
export interface ErrorIssueWorkflowServiceApi extends ErrorIssueWorkflowPublicApi {
	readonly rowToIssue: (
		row: ErrorIssueRow,
		hasOpenIncident: boolean,
		actorMap: Map<ActorId, ActorDocument>,
		activity: IssueActivityRollup,
		fingerprintHashes: ReadonlyArray<string>,
	) => ErrorIssueDocument
	readonly requireIssue: (
		orgId: OrgId,
		issueId: ErrorIssueId,
	) => Effect.Effect<ErrorIssueRow, ErrorPersistenceError | ErrorIssueNotFoundError>
	readonly issuesWithOpenIncidents: (
		orgId: OrgId,
		issueIds: ReadonlyArray<ErrorIssueId>,
	) => Effect.Effect<Set<ErrorIssueId>, ErrorPersistenceError>
	/** Batch issue hydration shared by read models and mutation responses. */
	readonly hydrateIssueRows: (
		orgId: OrgId,
		rows: ReadonlyArray<ErrorIssueRow>,
	) => Effect.Effect<ReadonlyArray<ErrorIssueDocument>, ErrorPersistenceError>
	readonly hydrateIssue: (
		orgId: OrgId,
		row: ErrorIssueRow,
	) => Effect.Effect<ErrorIssueDocument, ErrorPersistenceError>
	readonly recordEvent: (
		orgId: OrgId,
		issueId: ErrorIssueId,
		actorId: ActorId | null,
		type: ErrorIssueEventType,
		opts?: {
			readonly fromState?: WorkflowState | null
			readonly toState?: WorkflowState | null
			readonly payload?: StoredJsonRecord
			readonly timestamp?: number
		},
	) => Effect.Effect<unknown, ErrorPersistenceError>
	/**
	 * The insert `recordEvent` would write, for a caller that must commit the
	 * event atomically with its own statements in one transaction.
	 */
	readonly buildEvent: (
		orgId: OrgId,
		issueId: ErrorIssueId,
		actorId: ActorId | null,
		type: ErrorIssueEventType,
		timestamp: number,
		opts?: {
			readonly fromState?: WorkflowState | null
			readonly toState?: WorkflowState | null
			readonly payload?: StoredJsonRecord
		},
	) => ErrorIssueEventInsert
	/** Every fingerprint the issue owns, its own first. */
	readonly fingerprintHashesOf: (
		orgId: OrgId,
		row: ErrorIssueRow,
	) => Effect.Effect<ReadonlyArray<string>, ErrorPersistenceError>
	/** Mirror an actor-attributed issue event into the org audit log. Never fails. */
	readonly recordEventAudit: (
		orgId: OrgId,
		issueId: ErrorIssueId,
		actorId: ActorId,
		type: ErrorIssueEventType,
		opts: { readonly fromState?: WorkflowState | null; readonly toState?: WorkflowState | null },
	) => Effect.Effect<void>
	readonly applyTransition: (
		orgId: OrgId,
		actorId: ActorId | null,
		row: ErrorIssueRow,
		toState: WorkflowState,
		opts?: {
			readonly note?: string
			readonly snoozeUntilMs?: number | null
			readonly timestamp?: number
			readonly payload?: StoredJsonRecord
			/** Only apply while the snooze has elapsed by this time, so a renewed snooze wins. */
			readonly snoozeElapsedBy?: number
			/** Only apply while nobody holds the lease, so a claim taken since the read wins. */
			readonly unleased?: boolean
		},
	) => Effect.Effect<
		ErrorIssueRow,
		ErrorPersistenceError | ErrorIssueNotFoundError | ErrorIssueTransitionError
	>
}

const make: Effect.Effect<
	ErrorIssueWorkflowServiceApi,
	never,
	Database | ErrorActorsService | AuditLogService
> = Effect.gen(function* () {
	const database = yield* Database
	const actorsService = yield* ErrorActorsService
	const audit = yield* AuditLogService
	const dbExecute = makeErrorDatabaseExecute(database, "ErrorIssueWorkflowService")

	const newEventId = () => decodeEventIdSync(randomUUID())
	const newIssueEscalationId = () => decodeIssueEscalationIdSync(randomUUID())
	const isoFromMs = (ms: number) => decodeIssueDateTimeSync(new Date(ms).toISOString())

	const parseSourceRef = (json: unknown): StoredJsonRecord | null => {
		if (json == null) return null
		return Option.match(decodeStoredJsonRecord(json), {
			onNone: () => null,
			onSome: (parsed) => ({ ...parsed }),
		})
	}

	const rowToIssue: ErrorIssueWorkflowServiceApi["rowToIssue"] = (
		row,
		hasOpenIncident,
		actorMap,
		activity,
		fingerprintHashes,
	) =>
		new ErrorIssueDocument({
			id: row.id,
			kind: row.kind,
			fingerprintHash: row.fingerprintHash,
			fingerprintHashes,
			serviceName: row.serviceName,
			exceptionType: row.exceptionType,
			exceptionMessage: row.exceptionMessage,
			errorLabel: row.errorLabel,
			topFrame: row.topFrame,
			workflowState: row.workflowState,
			priority: row.priority,
			severity: row.severity ?? null,
			severitySource: row.severitySource ?? null,
			sourceRef: parseSourceRef(row.sourceRefJson),
			assignedActor: row.assignedActorId == null ? null : (actorMap.get(row.assignedActorId) ?? null),
			leaseHolder:
				row.leaseHolderActorId == null ? null : (actorMap.get(row.leaseHolderActorId) ?? null),
			leaseExpiresAt: row.leaseExpiresAt == null ? null : isoFromMs(row.leaseExpiresAt),
			claimedAt: row.claimedAt == null ? null : isoFromMs(row.claimedAt),
			notes: row.notes ?? null,
			firstSeenAt: isoFromMs(row.firstSeenAt),
			lastSeenAt: isoFromMs(row.lastSeenAt),
			occurrenceCount: row.occurrenceCount,
			resolvedAt: row.resolvedAt == null ? null : isoFromMs(row.resolvedAt),
			lastResolvedAt: row.lastResolvedAt == null ? null : isoFromMs(row.lastResolvedAt),
			lastRegressedAt: row.lastRegressedAt == null ? null : isoFromMs(row.lastRegressedAt),
			regressionCount: row.regressionCount,
			resolvedVersions: row.resolvedVersionsJson,
			snoozeUntil: row.snoozeUntil == null ? null : isoFromMs(row.snoozeUntil),
			archivedAt: row.archivedAt == null ? null : isoFromMs(row.archivedAt),
			mergedIntoIssueId: row.mergedIntoIssueId,
			hasOpenIncident,
			commentCount: activity.commentCount,
			openPullRequestCount: activity.openPullRequestCount,
			mergedPullRequestCount: activity.mergedPullRequestCount,
		})

	const rowToEvent = (
		row: ErrorIssueEventRow,
		actorMap: Map<ActorId, ActorDocument>,
	): ErrorIssueEventDocument =>
		new ErrorIssueEventDocument({
			id: row.id,
			issueId: row.issueId,
			actor: row.actorId == null ? null : (actorMap.get(row.actorId) ?? null),
			type: row.type,
			fromState: row.fromState ?? null,
			toState: row.toState ?? null,
			payload: Option.match(decodeStoredJsonRecord(row.payloadJson), {
				onNone: (): StoredJsonRecord => ({}),
				onSome: (parsed) => ({ ...parsed }),
			}),
			createdAt: isoFromMs(row.createdAt),
		})

	const requireIssue: ErrorIssueWorkflowServiceApi["requireIssue"] = Effect.fn(
		"ErrorIssueWorkflowService.requireIssue",
	)(function* (orgId, issueId) {
		const rows = yield* dbExecute((db) =>
			db.run(
				PG.from(ErrorIssues)
					.select()
					.where(($) => [$.orgId.eq(orgId), $.id.eq(issueId)])
					.limit(1),
			),
		)
		const row = rows[0]
		if (row === undefined) {
			return yield* new ErrorIssueNotFoundError({
				message: "Error issue not found",
				issueId,
			})
		}
		return row
	})

	const issuesWithOpenIncidents: ErrorIssueWorkflowServiceApi["issuesWithOpenIncidents"] = (
		orgId,
		issueIds,
	) => {
		if (issueIds.length === 0) return Effect.succeed(new Set<ErrorIssueId>())
		return Effect.all([
			dbExecute((db) =>
				db.run(
					PG.from(ErrorIncidents)
						.select("issueId")
						.where(($) => [$.orgId.eq(orgId), $.status.eq("open"), $.issueId.in_(...issueIds)]),
				),
			),
			dbExecute((db) =>
				db.run(
					PG.from(AlertIncidents)
						.select(($) => ({ issueId: $.errorIssueId }))
						.where(($) => [
							$.orgId.eq(orgId),
							$.status.eq("open"),
							$.errorIssueId.in_(...issueIds),
						]),
				),
			),
		]).pipe(
			Effect.map(
				([errorRows, alertRows]) =>
					new Set([
						...Arr.map(errorRows, (row) => row.issueId),
						...Arr.flatMap(alertRows, (row) => (row.issueId == null ? [] : [row.issueId])),
					]),
			),
		)
	}

	const EMPTY_ACTIVITY: IssueActivityRollup = {
		commentCount: 0,
		openPullRequestCount: 0,
		mergedPullRequestCount: 0,
	}

	const issueActivityRollups = (
		orgId: OrgId,
		issueIds: ReadonlyArray<ErrorIssueId>,
	): Effect.Effect<Map<ErrorIssueId, IssueActivityRollup>, ErrorPersistenceError> =>
		Effect.gen(function* () {
			const rollups = new Map<ErrorIssueId, IssueActivityRollup>()
			if (issueIds.length === 0) return rollups
			const upsert = (issueId: ErrorIssueId, patch: Partial<IssueActivityRollup>) =>
				rollups.set(issueId, { ...(rollups.get(issueId) ?? EMPTY_ACTIVITY), ...patch })
			const [commentRows, prRows] = yield* Effect.all([
				dbExecute((db) =>
					db.run(
						PG.from(ErrorIssueEvents)
							.select(($) => ({ issueId: $.issueId, count: PG.count() }))
							.where(($) => [
								$.orgId.eq(orgId),
								$.issueId.in_(...issueIds),
								$.type.in_("comment", "agent_note"),
							])
							.groupBy("issueId"),
					),
				),
				dbExecute((db) =>
					db.run(
						PG.from(ErrorIssuePullRequests)
							.select(($) => ({ issueId: $.issueId, state: $.state, count: PG.count() }))
							.where(($) => [$.orgId.eq(orgId), $.issueId.in_(...issueIds)])
							.groupBy("issueId", "state"),
					),
				),
			])
			for (const row of commentRows) upsert(row.issueId, { commentCount: row.count })
			for (const row of prRows) {
				if (row.state === "open") upsert(row.issueId, { openPullRequestCount: row.count })
				if (row.state === "merged") upsert(row.issueId, { mergedPullRequestCount: row.count })
			}
			return rollups
		})

	const hydrateNonEmpty = (orgId: OrgId, rows: Arr.NonEmptyReadonlyArray<ErrorIssueRow>) =>
		Effect.gen(function* () {
			const issueIds = Arr.map(rows, (row) => row.id)
			const openSet = yield* issuesWithOpenIncidents(orgId, issueIds)
			const activityMap = yield* issueActivityRollups(orgId, issueIds)
			const hashesByIssue = yield* dbExecute((db) => issueFingerprintHashes(db, orgId, rows))
			const actorMap = yield* actorsService.collectActorDocs(
				orgId,
				Arr.flatMap(rows, (row) => [row.assignedActorId ?? null, row.leaseHolderActorId ?? null]),
			)
			return Arr.map(rows, (row) =>
				rowToIssue(
					row,
					openSet.has(row.id),
					actorMap,
					activityMap.get(row.id) ?? EMPTY_ACTIVITY,
					hashesByIssue.get(row.id) ?? [row.fingerprintHash],
				),
			)
		})

	const hydrateIssueRows: ErrorIssueWorkflowServiceApi["hydrateIssueRows"] = (orgId, rows) =>
		Arr.isReadonlyArrayNonEmpty(rows) ? hydrateNonEmpty(orgId, rows) : Effect.succeed([])

	const hydrateIssue: ErrorIssueWorkflowServiceApi["hydrateIssue"] = Effect.fn(
		"ErrorIssueWorkflowService.hydrateIssue",
	)(function* (orgId, row) {
		const hydrated = yield* hydrateNonEmpty(orgId, [row])
		return Arr.headNonEmpty(hydrated)
	})

	const buildEventInsert = (
		orgId: OrgId,
		issueId: ErrorIssueId,
		actorId: ActorId | null,
		type: ErrorIssueEventType,
		timestamp: number,
		opts: {
			readonly fromState?: WorkflowState | null
			readonly toState?: WorkflowState | null
			readonly payload?: StoredJsonRecord
		} = {},
	): ErrorIssueEventInsert => ({
		id: newEventId(),
		orgId,
		issueId,
		actorId,
		type,
		fromState: opts.fromState ?? null,
		toState: opts.toState ?? null,
		payloadJson: opts.payload ?? {},
		createdAt: timestamp,
	})

	/**
	 * Mirror an actor-attributed issue event into the org audit log. Never
	 * fails: the issue event is already committed, and `audit.record` swallows
	 * its own errors — only the actor lookup can fail, so it is caught here.
	 */
	const recordEventAudit = (
		orgId: OrgId,
		issueId: ErrorIssueId,
		actorId: ActorId,
		type: ErrorIssueEventType,
		opts: { readonly fromState?: WorkflowState | null; readonly toState?: WorkflowState | null },
	) =>
		Effect.gen(function* () {
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(Actors)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.id.eq(actorId)])
						.limit(1),
				),
			)
			const actor = rows[0]
			if (actor === undefined || (actor.type !== "agent" && actor.type !== "user")) return
			// Maple's own sweeps run as an agent actor (`ensureSystemActor` mints
			// one), so without this check auto-close, lease expiry and fix
			// verification all read as a third-party agent acting over MCP.
			const isSystemActor = actor.type === "agent" && actor.agentName === SYSTEM_ERRORS_AGENT_NAME
			// The actors row knows *who*, never *how*: it is the same row whether
			// the mutation arrived from the dashboard, an API key, or MCP. The
			// request's `CurrentAuditActor` is the only thing that knows the
			// credential and surface, so a human actor is attributed through it and
			// falls back to a dashboard session only when nothing set it (queue
			// consumers, crons).
			const request = yield* CurrentAuditActor
			yield* audit.record({
				orgId,
				actor: isSystemActor
					? { type: "system", actorId, label: SYSTEM_ERRORS_AGENT_NAME }
					: actor.type === "agent"
						? {
								type: "agent",
								actorId,
								...(actor.agentName === null ? undefined : { label: actor.agentName }),
								// On-behalf-of: the human who registered the agent, the
								// closest authority the actor registry records.
								...(actor.createdBy === null ? undefined : { userId: actor.createdBy }),
							}
						: {
								type: request?.type ?? "user",
								...(actor.userId === null ? undefined : { userId: actor.userId }),
								...(request?.apiKeyId === undefined
									? undefined
									: { apiKeyId: request.apiKeyId }),
								actorId,
							},
				source: isSystemActor
					? "system"
					: actor.type === "agent"
						? "mcp"
						: (request?.source ?? "dashboard"),
				action: `error_issue.${type}`,
				resourceId: issueId,
				metadata: {
					...(opts.fromState != null ? { from_state: opts.fromState } : undefined),
					...(opts.toState != null ? { to_state: opts.toState } : undefined),
				},
			})
		}).pipe(
			// Typed failures and defects only — an interrupt must propagate so
			// fiber teardown never triggers a stray write.
			Effect.catch((error) =>
				Effect.logWarning("Issue event audit write failed", { issueId, cause: error }),
			),
			Effect.catchDefect((defect) =>
				Effect.logWarning("Issue event audit write failed", { issueId, cause: defect }),
			),
		)

	const recordEvent: ErrorIssueWorkflowServiceApi["recordEvent"] = Effect.fn(
		"ErrorIssueWorkflowService.recordEvent",
	)(function* (orgId, issueId, actorId, type, opts = {}) {
		const timestamp = opts.timestamp ?? (yield* Clock.currentTimeMillis)
		const insert = buildEventInsert(orgId, issueId, actorId ?? null, type, timestamp, opts)
		const inserted = yield* dbExecute((db) => db.run(PG.insertInto(ErrorIssueEvents).values(insert)))
		// System/sweep events carry no actor and stay out of the audit log.
		if (actorId !== null) {
			yield* recordEventAudit(orgId, issueId, actorId, type, opts)
		}
		return inserted
	})

	/**
	 * The message is half the point. "Illegal transition from 'triage' to
	 * 'in_review'" told a caller nothing it could act on, and it was the single
	 * most common MCP error in the internal org — so it now names the moves that
	 * would work, from the same matrix that rejected this one.
	 */
	const validateTransition = (issueId: ErrorIssueId, from: WorkflowState, to: WorkflowState) => {
		if (!WORKFLOW_TRANSITIONS[from].includes(to)) {
			const offered = Arr.filter(
				WORKFLOW_TRANSITIONS[from],
				(target) => !MACHINE_OWNED_WORKFLOW_STATES.has(target),
			)
			return Effect.fail(
				new ErrorIssueTransitionError({
					message:
						offered.length === 0
							? `Cannot move an issue out of '${from}'.`
							: `Cannot move an issue from '${from}' to '${to}'. From '${from}' it can go to: ${Arr.join(offered, ", ")}.`,
					issueId,
					fromState: from,
					toState: to,
				}),
			)
		}
		return Effect.void
	}

	const applyTransition: ErrorIssueWorkflowServiceApi["applyTransition"] = Effect.fn(
		"ErrorIssueWorkflowService.applyTransition",
	)(function* (orgId, actorId, row, toState, opts = {}) {
		const timestamp = opts.timestamp ?? (yield* Clock.currentTimeMillis)
		const fromState = row.workflowState
		if (fromState === toState) return row
		yield* validateTransition(row.id, fromState, toState)

		const previousLease = row.leaseExpiresAt ?? timestamp
		const refreshesLease = actorId !== null && actorId !== undefined && row.leaseHolderActorId === actorId
		const update: PG.UpdateSetOf<typeof ErrorIssues> = {
			workflowState: toState,
			updatedAt: timestamp,
			...(toState === "done"
				? {
						resolvedAt: timestamp,
						resolvedByActorId: actorId ?? null,
						// Survives the next reopen, so a regressed issue can still show when it
						// was last fixed instead of looking untouched.
						lastResolvedAt: timestamp,
						// Snapshot the builds this issue has been seen from. Occurrences from
						// any of them afterwards are old clients still running the broken
						// build, not a regression — see `isRegression` in
						// error-tick-persistence.ts. Without this, `maple-cli` issues could
						// never stay fixed: every binary already installed keeps reporting the
						// bug for as long as it is in use.
						resolvedVersionsJson: row.seenVersionsJson,
					}
				: fromState === "done"
					? { resolvedAt: null, resolvedByActorId: null }
					: undefined),
			...(toState === "wontfix"
				? opts.snoozeUntilMs !== undefined
					? { snoozeUntil: opts.snoozeUntilMs }
					: undefined
				: fromState === "wontfix"
					? { snoozeUntil: null }
					: undefined),
			// Reaching a terminal state ends the work, so the lease ends with it.
			// Otherwise a holder still working just proved it, folded into this same
			// UPDATE rather than issued separately: the row is already being written.
			...(CLOSED_WORKFLOW_STATES.has(toState)
				? { leaseHolderActorId: null, leaseExpiresAt: null, claimedAt: null }
				: refreshesLease
					? {
							leaseExpiresAt:
								timestamp +
								Math.max(
									DEFAULT_LEASE_DURATION_MS,
									previousLease - (row.claimedAt ?? previousLease),
								),
						}
					: undefined),
		}

		const notePayload: StoredJsonRecord = opts.note
			? { ...opts.payload, note: opts.note }
			: { ...opts.payload }
		const eventInsert = buildEventInsert(orgId, row.id, actorId ?? null, "state_change", timestamp, {
			fromState,
			toState,
			payload: notePayload,
		})
		// One transaction, because a `done` that committed the issue but lost the
		// incident resolution or its timeline event could never be repaired: a
		// retry sees `fromState === toState` and returns before reaching them.
		// Guarded on the state that was validated: a concurrent transition that landed first
		// makes this one a 409 instead of a silent overwrite, and rolls the transaction back.
		yield* dbExecute((db) =>
			db.transaction(
				Effect.gen(function* () {
					yield* transitionRow(
						{ table: "error_issues", id: row.id, from: [fromState], to: toState },
						(from) =>
							db.run(
								PG.update(ErrorIssues)
									.set(update)
									.where(($) => [
										$.orgId.eq(orgId),
										$.id.eq(row.id),
										$.workflowState.in_(...from),
										opts.snoozeElapsedBy === undefined
											? undefined
											: $.snoozeUntil.lte(opts.snoozeElapsedBy),
										opts.unleased === true ? $.leaseHolderActorId.isNull() : undefined,
									])
									.returning("id"),
							),
					)
					if (toState === "done") {
						yield* db.run(
							PG.update(ErrorIncidents)
								.set({ status: "resolved", resolvedAt: timestamp, updatedAt: timestamp })
								.where(($) => [$.orgId.eq(orgId), $.issueId.eq(row.id), $.status.eq("open")]),
						)
						yield* db.run(
							PG.update(ErrorIssueStates)
								.set({ openIncidentId: null, updatedAt: timestamp })
								.where(($) => [$.orgId.eq(orgId), $.issueId.eq(row.id)]),
						)
					}
					yield* db.run(PG.insertInto(ErrorIssueEvents).values(eventInsert))
				}),
			),
		).pipe(
			Effect.catchTag("@maple/backend/TransitionConflictError", () =>
				Effect.fail(
					new ErrorIssueTransitionError({
						message: `The issue moved out of '${fromState}' while this change to '${toState}' was in flight. Re-read it and retry.`,
						issueId: row.id,
						fromState,
						toState,
					}),
				),
			),
		)
		if (actorId) {
			yield* recordEventAudit(orgId, row.id, actorId, "state_change", { fromState, toState })
			yield* actorsService.touchActor(orgId, actorId, timestamp)
		}
		return yield* requireIssue(orgId, row.id)
	})

	const leaseConflict = (issueId: ErrorIssueId, row: ErrorIssueRow | null) =>
		new ErrorIssueLeaseConflictError({
			message: "Issue is held by another actor",
			issueId,
			currentHolderActorId: row?.leaseHolderActorId ?? null,
			leaseExpiresAt: row?.leaseExpiresAt == null ? null : isoFromMs(row.leaseExpiresAt),
		})

	const heartbeatIssue: ErrorIssueWorkflowServiceApi["heartbeatIssue"] = Effect.fn(
		"ErrorIssueWorkflowService.heartbeatIssue",
	)(function* (orgId, actorId, issueId) {
		const timestamp = yield* Clock.currentTimeMillis
		const current = yield* requireIssue(orgId, issueId)
		if (current.leaseHolderActorId !== actorId) {
			return yield* leaseConflict(issueId, current)
		}
		const previous = current.leaseExpiresAt ?? timestamp
		const leaseMs = Math.max(DEFAULT_LEASE_DURATION_MS, previous - (current.claimedAt ?? previous))
		const leaseExpiresAt = timestamp + leaseMs
		const heartbeatRows = yield* dbExecute((db) =>
			db.run(
				PG.update(ErrorIssues)
					.set({ leaseExpiresAt, updatedAt: timestamp })
					.where(($) => [$.orgId.eq(orgId), $.id.eq(issueId), $.leaseHolderActorId.eq(actorId)])
					.returning(() => ({ txid: currentTxid })),
			),
		)
		yield* actorsService.touchActor(orgId, actorId, timestamp)
		const next = yield* requireIssue(orgId, issueId)
		const doc = yield* hydrateIssue(orgId, next)
		const txid = readTxid(heartbeatRows)
		return txid === undefined ? doc : new ErrorIssueDocument({ ...doc, txid })
	})

	/**
	 * Push the lease deadline out because the holder is demonstrably still working.
	 *
	 * A lease used to expire on wall-clock time alone, renewable only by an explicit
	 * `heartbeat` call — and in practice nothing ever called it: agents claimed
	 * issues, worked them, and let the lease lapse, dropping the issue back to
	 * `todo` underneath them. Any mutating action by the holder is better evidence
	 * of liveness than a separate call the agent has to remember to make.
	 *
	 * Silent by design: a no-op for a non-holder (the caller's own conflict check
	 * owns that decision) and never a reason to fail the action it accompanies.
	 */
	const refreshLeaseIfHolder = Effect.fn("ErrorIssueWorkflowService.refreshLeaseIfHolder")(function* (
		orgId: OrgId,
		actorId: ActorId,
		issueId: ErrorIssueId,
		current: ErrorIssueRow,
		timestamp: number,
	) {
		if (current.leaseHolderActorId !== actorId) return
		const previous = current.leaseExpiresAt ?? timestamp
		// Preserve the lease LENGTH the holder originally asked for, exactly as
		// `heartbeatIssue` does — a claim with a 2h lease should keep renewing at 2h.
		const leaseMs = Math.max(DEFAULT_LEASE_DURATION_MS, previous - (current.claimedAt ?? previous))
		yield* dbExecute((db) =>
			db.run(
				PG.update(ErrorIssues)
					.set({ leaseExpiresAt: timestamp + leaseMs })
					.where(($) => [$.orgId.eq(orgId), $.id.eq(issueId), $.leaseHolderActorId.eq(actorId)]),
			),
		)
	})

	const releaseIssue: ErrorIssueWorkflowServiceApi["releaseIssue"] = Effect.fn(
		"ErrorIssueWorkflowService.releaseIssue",
	)(function* (orgId, actorId, issueId, opts) {
		const timestamp = yield* Clock.currentTimeMillis
		const current = yield* requireIssue(orgId, issueId)
		if (current.leaseHolderActorId !== null && current.leaseHolderActorId !== actorId) {
			return yield* leaseConflict(issueId, current)
		}
		// Guard on the holder the check above saw: a claim committed in between wins.
		const released = yield* dbExecute((db) =>
			db.run(
				PG.update(ErrorIssues)
					.set({
						leaseHolderActorId: null,
						leaseExpiresAt: null,
						claimedAt: null,
						updatedAt: timestamp,
					})
					.where(($) => [
						$.orgId.eq(orgId),
						$.id.eq(issueId),
						PG.or($.leaseHolderActorId.isNull(), $.leaseHolderActorId.eq(actorId)),
					])
					.returning("id"),
			),
		)
		if (released.length === 0) {
			const winner = yield* requireIssue(orgId, issueId)
			return yield* leaseConflict(issueId, winner)
		}
		yield* recordEvent(orgId, issueId, actorId, "release", {
			payload: opts?.note ? { note: opts.note } : {},
			timestamp,
		})
		const target: WorkflowState =
			opts?.transitionTo ?? (current.workflowState === "in_progress" ? "todo" : current.workflowState)
		let next = yield* requireIssue(orgId, issueId)
		if (target !== next.workflowState) {
			next = yield* applyTransition(orgId, actorId, next, target, {
				payload: { viaRelease: true },
				timestamp,
			})
		}
		yield* actorsService.touchActor(orgId, actorId, timestamp)
		return yield* hydrateIssue(orgId, next)
	})

	const assignIssue: ErrorIssueWorkflowServiceApi["assignIssue"] = Effect.fn(
		"ErrorIssueWorkflowService.assignIssue",
	)(function* (orgId, byActorId, issueId, toActorId) {
		const timestamp = yield* Clock.currentTimeMillis
		const current = yield* requireIssue(orgId, issueId)
		if (toActorId !== null && !(yield* actorsService.actorExists(orgId, toActorId))) {
			return yield* new ActorNotFoundError({
				message: `Actor '${toActorId}' not found`,
				actorId: toActorId,
			})
		}
		const assignedRows = yield* dbExecute((db) =>
			db.run(
				PG.update(ErrorIssues)
					.set({ assignedActorId: toActorId, updatedAt: timestamp })
					.where(($) => [$.orgId.eq(orgId), $.id.eq(issueId)])
					.returning(() => ({ txid: currentTxid })),
			),
		)
		yield* recordEvent(orgId, issueId, byActorId, "assignment", {
			payload: { fromActorId: current.assignedActorId, toActorId },
			timestamp,
		})
		yield* actorsService.touchActor(orgId, byActorId, timestamp)
		const next = yield* requireIssue(orgId, issueId)
		const doc = yield* hydrateIssue(orgId, next)
		const txid = readTxid(assignedRows)
		return txid === undefined ? doc : new ErrorIssueDocument({ ...doc, txid })
	})

	/** The outbox row a severity change owes, or none when the change does not escalate. */
	const severityEscalationInsert = (
		orgId: OrgId,
		issueId: ErrorIssueId,
		from: IssueSeverity | null,
		to: IssueSeverity,
		source: "ai" | "manual",
		timestamp: number,
	): Option.Option<PG.InsertRowOf<typeof IssueEscalations>> =>
		Option.map(Option.fromNullOr(escalationReasonFor(from, to)), (reason) => ({
			id: newIssueEscalationId(),
			orgId,
			issueId,
			severity: to,
			source,
			reason,
			runId: null,
			investigationId: null,
			payloadJson: {},
			deliveryResultsJson: [],
			status: "queued",
			attempts: 0,
			dedupeKey: escalationDedupeKey(orgId, issueId, to),
			error: null,
			createdAt: timestamp,
			processedAt: null,
		}))

	const setSeverity: ErrorIssueWorkflowServiceApi["setSeverity"] = Effect.fn(
		"ErrorIssueWorkflowService.setSeverity",
	)(function* (orgId, actorId, issueId, severity, opts) {
		const timestamp = yield* Clock.currentTimeMillis
		const source = opts?.source ?? "manual"
		yield* Effect.annotateCurrentSpan({
			orgId,
			"maple.issue.id": issueId,
			"maple.errors.severity": severity ?? "null",
			"maple.errors.source": source,
		})
		const current = yield* requireIssue(orgId, issueId)
		if (source === "ai" && current.severitySource === "manual") {
			return yield* hydrateIssue(orgId, current)
		}
		yield* refreshLeaseIfHolder(orgId, actorId, issueId, current, timestamp)
		const nextSource: IssueSeveritySource | null = severity === null ? null : source
		const changed = current.severity !== severity || current.severitySource !== nextSource
		if (!changed) return yield* hydrateIssue(orgId, current)

		const payload: StoredJsonRecord = opts?.note
			? { from: current.severity, to: severity, source, note: opts.note }
			: { from: current.severity, to: severity, source }
		const eventInsert =
			current.severity !== severity
				? Option.some(
						buildEventInsert(orgId, issueId, actorId, "severity_change", timestamp, {
							payload,
						}),
					)
				: Option.none()
		// Clearing the severity (null) never escalates; a set severity may.
		const escalationInsert = Option.flatMap(Option.fromNullOr(severity), (next) =>
			severityEscalationInsert(orgId, issueId, current.severity, next, source, timestamp),
		)
		// One transaction: a severity that committed without its escalation row
		// could never page anyone — a retry sees the severity already stored and
		// returns before reaching the outbox insert.
		const severityRows = yield* dbExecute((db) =>
			db.transaction(
				Effect.gen(function* () {
					const rows = yield* db.run(
						PG.update(ErrorIssues)
							.set({ severity, severitySource: nextSource, updatedAt: timestamp })
							.where(($) => [$.orgId.eq(orgId), $.id.eq(issueId)])
							.returning(() => ({ txid: currentTxid })),
					)
					if (Option.isSome(eventInsert))
						yield* db.run(PG.insertInto(ErrorIssueEvents).values(eventInsert.value))
					if (Option.isSome(escalationInsert)) {
						yield* db.run(
							PG.insertInto(IssueEscalations)
								.values(escalationInsert.value)
								.onConflictDoNothing(),
						)
					}
					return rows
				}),
			),
		)
		if (Option.isSome(eventInsert)) {
			yield* recordEventAudit(orgId, issueId, actorId, "severity_change", {})
		}
		yield* actorsService.touchActor(orgId, actorId, timestamp)
		const next = yield* requireIssue(orgId, issueId)
		const doc = yield* hydrateIssue(orgId, next)
		const txid = readTxid(severityRows)
		return txid === undefined ? doc : new ErrorIssueDocument({ ...doc, txid })
	})

	const commentOnIssue: ErrorIssueWorkflowServiceApi["commentOnIssue"] = Effect.fn(
		"ErrorIssueWorkflowService.commentOnIssue",
	)(function* (orgId, actorId, issueId, body, opts) {
		const timestamp = yield* Clock.currentTimeMillis
		const current = yield* requireIssue(orgId, issueId)
		yield* refreshLeaseIfHolder(orgId, actorId, issueId, current, timestamp)
		const type: ErrorIssueEventType = opts?.kind === "agent_note" ? "agent_note" : "comment"
		const payload: StoredJsonRecord = {
			body,
			visibility: opts?.visibility ?? "internal",
		}
		const id = newEventId()
		const row: ErrorIssueEventRow = {
			id,
			orgId,
			issueId,
			actorId,
			type,
			fromState: null,
			toState: null,
			payloadJson: payload,
			createdAt: timestamp,
		}
		yield* dbExecute((db) => db.run(PG.insertInto(ErrorIssueEvents).values(row)))
		// This path writes the event row itself rather than going through
		// `recordEvent`, so the audit mirror has to be invoked explicitly. The
		// comment body stays out of the row — the audit records that a comment
		// was made, not what it said.
		yield* recordEventAudit(orgId, issueId, actorId, type, {})
		yield* actorsService.touchActor(orgId, actorId, timestamp)
		const actorMap = yield* actorsService.collectActorDocs(orgId, [actorId])
		return rowToEvent(row, actorMap)
	})

	const listIssueEvents: ErrorIssueWorkflowServiceApi["listIssueEvents"] = Effect.fn(
		"ErrorIssueWorkflowService.listIssueEvents",
	)(function* (orgId, issueId, opts) {
		yield* Effect.annotateCurrentSpan({ orgId, "maple.issue.id": issueId })
		yield* requireIssue(orgId, issueId)
		const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_EVENTS_LIMIT, 1), 500)
		const rows = yield* dbExecute((db) =>
			db.run(
				PG.from(ErrorIssueEvents)
					.select()
					.where(($) => [$.orgId.eq(orgId), $.issueId.eq(issueId)])
					.orderBy(["createdAt", "desc"])
					.limit(limit),
			),
		)
		const actorMap = yield* actorsService.collectActorDocs(
			orgId,
			Arr.map(rows, (row) => row.actorId ?? null),
		)
		return new ErrorIssueEventsResponse({
			events: Arr.map(rows, (row) => rowToEvent(row, actorMap)),
		})
	})

	return ErrorIssueWorkflowService.of({
		rowToIssue,
		requireIssue,
		issuesWithOpenIncidents,
		hydrateIssueRows,
		hydrateIssue,
		recordEvent,
		buildEvent: buildEventInsert,
		fingerprintHashesOf: (orgId, row) =>
			dbExecute((db) => issueFingerprintHashes(db, orgId, [row])).pipe(
				Effect.map((owned) => owned.get(row.id) ?? [row.fingerprintHash]),
			),
		recordEventAudit,
		applyTransition,
		heartbeatIssue,
		releaseIssue,
		assignIssue,
		setSeverity,
		commentOnIssue,
		listIssueEvents,
	})
})

export class ErrorIssueWorkflowService extends Context.Service<
	ErrorIssueWorkflowService,
	ErrorIssueWorkflowServiceApi
>()("@maple/backend/services/errors/ErrorIssueWorkflowService", { make }) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(AuditLogService.layer, ErrorActorsService.layer)),
	)
}
