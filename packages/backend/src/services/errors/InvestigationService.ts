// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
import { randomUUID } from "node:crypto"
import {
	type AiTriageIncidentKind,
	AiTriageResult,
	type InvestigationConfidence,
	InvestigationCreateRequest,
	InvestigationDataCorruptionError,
	InvestigationDocument,
	InvestigationAgentUnavailableError,
	InvestigationNotFoundError,
	InvestigationPersistenceError,
	InvestigationStartFailedError,
	InvestigationSnapshotFact,
	InvestigationSubjectSnapshot,
	InvestigationsListResponse,
	type InvestigationStatus,
	InvestigationSubject,
	type OrgId,
	type SubmitDiagnosisRequest,
	type UserId,
} from "@maple/domain/http"
import { ErrorIssueId, InvestigationId } from "@maple/domain/primitives"

import { investigations, type InvestigationRow } from "@maple/db"
import { WorkerEnvironment } from "@maple/infra/worker-runtime"
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { applyDiagnosisWrites, subjectTypeOf } from "@maple/backend/services/errors/apply-diagnosis"
import { startInvestigationTurn } from "@maple/backend/services/errors/investigation-start"
import {
	STALE_MS,
	isInvestigationStale,
	staleTimeoutMessage,
} from "@maple/backend/services/errors/investigation-stale"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"

const decodeIdSync = Schema.decodeUnknownSync(InvestigationId)
const decodeIsoSync = Schema.decodeUnknownSync(InvestigationDocument.fields.createdAt)

export const newInvestigationId = () => decodeIdSync(randomUUID())

const makePersistenceError = makePersistenceErrorMapper(
	InvestigationPersistenceError,
	"Investigation persistence failure",
)

export interface ListInvestigationsOptions {
	readonly issueId?: ErrorIssueId
	readonly incidentKind?: AiTriageIncidentKind
	readonly incidentId?: string
	readonly status?: InvestigationStatus
	readonly limit?: number
	readonly offset?: number
}

export interface InvestigationServiceApi {
	readonly listInvestigations: (
		orgId: OrgId,
		opts: ListInvestigationsOptions,
	) => Effect.Effect<
		InvestigationsListResponse,
		InvestigationPersistenceError | InvestigationDataCorruptionError
	>
	readonly getInvestigation: (
		orgId: OrgId,
		id: InvestigationId,
	) => Effect.Effect<
		InvestigationDocument,
		InvestigationPersistenceError | InvestigationNotFoundError | InvestigationDataCorruptionError
	>
	readonly createInvestigation: (
		orgId: OrgId,
		userId: UserId | null,
		request: InvestigationCreateRequest,
	) => Effect.Effect<
		InvestigationDocument,
		InvestigationPersistenceError | InvestigationDataCorruptionError
	>
	readonly createAndStartInvestigation: (
		orgId: OrgId,
		userId: UserId | null,
		request: InvestigationCreateRequest,
	) => Effect.Effect<
		InvestigationDocument,
		| InvestigationPersistenceError
		| InvestigationAgentUnavailableError
		| InvestigationStartFailedError
		| InvestigationDataCorruptionError
	>
	readonly restartInvestigation: (
		orgId: OrgId,
		id: InvestigationId,
	) => Effect.Effect<
		InvestigationDocument,
		| InvestigationPersistenceError
		| InvestigationNotFoundError
		| InvestigationAgentUnavailableError
		| InvestigationStartFailedError
		| InvestigationDataCorruptionError
	>
	readonly updateStatus: (
		orgId: OrgId,
		id: InvestigationId,
		status: InvestigationStatus,
	) => Effect.Effect<
		InvestigationDocument,
		InvestigationPersistenceError | InvestigationNotFoundError | InvestigationDataCorruptionError
	>
	readonly submitDiagnosis: (
		orgId: OrgId,
		id: InvestigationId,
		request: SubmitDiagnosisRequest,
	) => Effect.Effect<
		InvestigationDocument,
		InvestigationPersistenceError | InvestigationNotFoundError | InvestigationDataCorruptionError
	>
	/**
	 * Record that the autonomous pass ended without a diagnosis. Only a row still
	 * `investigating` moves; a diagnosis that landed meanwhile is never overwritten.
	 */
	readonly failInvestigation: (
		orgId: OrgId,
		id: InvestigationId,
		error: string,
	) => Effect.Effect<void, InvestigationPersistenceError>
}

export class InvestigationService extends Context.Service<InvestigationService, InvestigationServiceApi>()(
	"@maple/api/services/InvestigationService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const workerEnv = yield* Effect.serviceOption(WorkerEnvironment)

			const dbExecute = makeDbExecute(database, "InvestigationService", makePersistenceError)

			const iso = (date: Date) => decodeIsoSync(date.toISOString())

			const fallbackSnapshot = (subject: InvestigationSubject) =>
				new InvestigationSubjectSnapshot({
					title:
						subject.type === "freeform"
							? subject.title
							: subject.type === "fix_verification"
								? "Fix verification"
								: `${subject.incidentKind[0]?.toUpperCase() ?? ""}${subject.incidentKind.slice(1)} incident`,
					scope: null,
					status: "open",
					severity: null,
					facts:
						subject.type === "incident"
							? [
									new InvestigationSnapshotFact({
										label: "Incident",
										value: subject.incidentId,
									}),
								]
							: subject.type === "fix_verification"
								? [
										new InvestigationSnapshotFact({
											label: "Pull request",
											value: subject.pullRequestUrl,
										}),
									]
								: [],
					references: [],
					incidentStartedAt: null,
					incidentEndedAt: null,
				})

			const storedValueLabel = (value: unknown): string => {
				if (value === null) return "null"
				if (value === undefined) return "undefined"
				if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
					return String(value)
				}
				return "[stored JSON]"
			}

			const storedDataCorruption = (
				investigationId: InvestigationId,
				field: string,
				value: unknown,
				cause: unknown,
			) =>
				new InvestigationDataCorruptionError({
					message: `Stored investigation ${field} is invalid`,
					investigationId,
					field,
					value: storedValueLabel(value),
					cause,
				})

			const decodeStoredField = <S extends Schema.Top>(
				investigationId: InvestigationId,
				field: string,
				schema: S,
				value: unknown,
			): Effect.Effect<S["Type"], InvestigationDataCorruptionError, S["DecodingServices"]> =>
				Schema.decodeUnknownEffect(schema)(value).pipe(
					Effect.mapError((cause) => storedDataCorruption(investigationId, field, value, cause)),
				)

			const parseReport = (row: InvestigationRow) =>
				row.reportJson == null
					? Effect.succeed(null)
					: decodeStoredField(row.id, "report", AiTriageResult, row.reportJson)

			const rowToDocument = Effect.fnUntraced(function* (row: InvestigationRow) {
				const subject = yield* decodeStoredField(
					row.id,
					"subject",
					InvestigationSubject,
					row.subjectJson,
				)
				const snapshot =
					row.snapshotJson == null
						? fallbackSnapshot(subject)
						: yield* decodeStoredField(
								row.id,
								"snapshot",
								InvestigationSubjectSnapshot,
								row.snapshotJson,
							)
				const report = yield* parseReport(row)
				return yield* Effect.try({
					try: () =>
						new InvestigationDocument({
							id: decodeIdSync(row.id),
							status: row.status,
							subject,
							snapshot,
							report,
							model: row.model ?? null,
							severity: row.severity ?? null,
							confidence: row.confidence ?? null,
							seededBy: row.seededBy,
							createdBy: row.createdBy ?? null,
							inputTokens: row.inputTokens ?? null,
							outputTokens: row.outputTokens ?? null,
							error: row.error ?? null,
							createdAt: iso(row.createdAt),
							startedAt: row.startedAt ? iso(row.startedAt) : null,
							diagnosedAt: row.diagnosedAt ? iso(row.diagnosedAt) : null,
							updatedAt: iso(row.updatedAt),
						}),
					catch: (cause) => storedDataCorruption(row.id, "document", row.id, cause),
				})
			})

			const loadRow = (orgId: OrgId, id: InvestigationId) =>
				dbExecute((db) =>
					db
						.select()
						.from(investigations)
						.where(and(eq(investigations.orgId, orgId), eq(investigations.id, id)))
						.limit(1),
				).pipe(Effect.map((rows) => rows[0]))

			const documentFor = (_orgId: OrgId, row: InvestigationRow) => rowToDocument(row)

			// Look up the single incident-anchored row (the partial unique index key).
			// Used for both the dedup fast-path and the concurrent-insert race loser.
			const loadIncidentRow = (orgId: OrgId, incidentKind: AiTriageIncidentKind, incidentId: string) =>
				dbExecute((db) =>
					db
						.select()
						.from(investigations)
						.where(
							and(
								eq(investigations.orgId, orgId),
								eq(investigations.incidentKind, incidentKind),
								eq(investigations.incidentId, incidentId),
							),
						)
						.limit(1),
				).pipe(Effect.map((rows) => rows[0]))

			/**
			 * A row still claiming to be investigating long after its autonomous pass
			 * should have submitted a diagnosis. Checked before sweeping so a read
			 * doesn't issue an UPDATE that would match nothing — the investigation
			 * detail page polls every 3s, which otherwise turns every read into a write.
			 */
			const isStale = (row: InvestigationRow, nowMs: number): boolean =>
				isInvestigationStale(row, nowMs)

			const failStaleInvestigations = Effect.fnUntraced(function* (orgId: OrgId, nowMs: number) {
				yield* dbExecute((db) =>
					db
						.update(investigations)
						.set({
							status: "failed",
							error: staleTimeoutMessage(STALE_MS),
							updatedAt: new Date(nowMs),
						})
						.where(
							and(
								eq(investigations.orgId, orgId),
								eq(investigations.status, "investigating"),
								lt(investigations.startedAt, new Date(nowMs - STALE_MS)),
							),
						),
				).pipe(Effect.asVoid)
			})

			/**
			 * Kick off the investigation's autonomous pass: one turn on the `ChatSession`
			 * Durable Object, which runs it inside itself. Nothing here keeps the turn
			 * alive, which is what makes it survive a cron tick's runtime being disposed.
			 */
			const sendAutonomousTurn = Effect.fnUntraced(function* (
				orgId: OrgId,
				doc: InvestigationDocument,
				nowMs: number,
			) {
				const started = yield* startInvestigationTurn({
					orgId,
					investigationId: doc.id,
					subject: doc.subject,
					snapshot: doc.snapshot,
					workerEnv: Option.getOrUndefined(workerEnv),
					nowMs,
				}).pipe(Effect.mapError(makePersistenceError), Effect.provideService(Database, database))
				if (started.started) return
				if (started.reason === "no_binding") {
					return yield* Effect.fail(
						new InvestigationAgentUnavailableError({
							message: "The investigation agent is temporarily unavailable.",
						}),
					)
				}
				return yield* Effect.fail(
					new InvestigationStartFailedError({
						message:
							started.reason === "busy"
								? "This investigation already has a turn in flight."
								: "The investigation agent could not start a turn.",
					}),
				)
			})

			const listInvestigations: InvestigationServiceApi["listInvestigations"] = Effect.fn(
				"InvestigationService.listInvestigations",
			)(function* (orgId, opts) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const conditions = [
					eq(investigations.orgId, orgId),
					opts.issueId ? eq(investigations.issueId, opts.issueId) : undefined,
					opts.incidentKind ? eq(investigations.incidentKind, opts.incidentKind) : undefined,
					opts.incidentId ? eq(investigations.incidentId, opts.incidentId) : undefined,
					opts.status ? eq(investigations.status, opts.status) : undefined,
				].filter((c): c is NonNullable<typeof c> => c !== undefined)
				const selectPage = dbExecute((db) =>
					db
						.select()
						.from(investigations)
						.where(and(...conditions))
						.orderBy(desc(investigations.createdAt), desc(investigations.id))
						.limit(opts.limit ?? 50)
						.offset(opts.offset ?? 0),
				)
				let rows = yield* selectPage
				const nowMs = yield* Clock.currentTimeMillis
				// Sweep only when this page actually contains a timed-out run, then
				// re-read so the caller sees the corrected status.
				if (rows.some((row) => isStale(row, nowMs))) {
					yield* failStaleInvestigations(orgId, nowMs)
					rows = yield* selectPage
				}
				return new InvestigationsListResponse({
					investigations: yield* Effect.forEach(rows, (row) => rowToDocument(row)),
				})
			})

			const getInvestigation: InvestigationServiceApi["getInvestigation"] = Effect.fn(
				"InvestigationService.getInvestigation",
			)(function* (orgId, id) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.investigation.id": id })
				const row = yield* loadRow(orgId, id)
				if (!row) {
					return yield* Effect.fail(
						new InvestigationNotFoundError({ message: `No such investigation: '${id}'` }),
					)
				}
				const nowMs = yield* Clock.currentTimeMillis
				if (!isStale(row, nowMs)) return yield* documentFor(orgId, row)
				// This run timed out: settle it, then report the corrected status.
				yield* failStaleInvestigations(orgId, nowMs)
				const settled = yield* loadRow(orgId, id)
				return yield* documentFor(orgId, settled ?? row)
			})

			const createInvestigation: InvestigationServiceApi["createInvestigation"] = Effect.fn(
				"InvestigationService.createInvestigation",
			)(function* (orgId, userId, request) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.investigation.subject_type": request.subject.type,
				})
				const nowMs = yield* Clock.currentTimeMillis
				const subject = request.subject

				// Incident-anchored investigations dedup to one row per incident: if one
				// already exists, return it (re-opening the same war-room) instead of
				// creating a duplicate. Free-form investigations are always new.
				if (subject.type === "incident") {
					const existing = yield* loadIncidentRow(orgId, subject.incidentKind, subject.incidentId)
					if (existing) return yield* documentFor(orgId, existing)
				}

				const id = newInvestigationId()
				const incidentColumns =
					subject.type === "incident"
						? {
								incidentKind: subject.incidentKind,
								incidentId: subject.incidentId,
								issueId: subject.issueId ?? null,
							}
						: { incidentKind: null, incidentId: null, issueId: null }

				// `onConflictDoNothing` makes the dedup race-safe: two concurrent
				// incident-open seeds both pass the SELECT above, but the partial unique
				// index (org, kind, incident_id) lets only one INSERT win. The loser gets
				// no returned row and re-reads the winner instead of surfacing a 503.
				const inserted = yield* dbExecute((db) =>
					db
						.insert(investigations)
						.values({
							id,
							orgId,
							status: "investigating",
							seededBy: userId ? "user" : "system",
							subjectJson: subject,
							snapshotJson: request.snapshot ?? fallbackSnapshot(subject),
							...incidentColumns,
							createdBy: userId,
							createdAt: new Date(nowMs),
							updatedAt: new Date(nowMs),
						})
						.onConflictDoNothing()
						.returning({ id: investigations.id }),
				)

				if (inserted.length === 0) {
					if (subject.type === "incident") {
						const winner = yield* loadIncidentRow(orgId, subject.incidentKind, subject.incidentId)
						if (winner) return yield* documentFor(orgId, winner)
					}
					return yield* Effect.fail(
						new InvestigationPersistenceError({
							message: "Investigation insert conflicted with no resolvable row",
						}),
					)
				}

				const row = yield* loadRow(orgId, id)
				if (!row) {
					return yield* Effect.fail(
						new InvestigationPersistenceError({
							message: "Investigation row missing after insert",
						}),
					)
				}
				return yield* documentFor(orgId, row)
			})

			const createAndStartInvestigation: InvestigationServiceApi["createAndStartInvestigation"] =
				Effect.fn("InvestigationService.createAndStartInvestigation")(
					function* (orgId, userId, request) {
						yield* Effect.annotateCurrentSpan({
							orgId,
							"maple.investigation.subject_type": request.subject.type,
							"maple.investigation.creation_source": "manual",
						})
						const nowMs = yield* Clock.currentTimeMillis
						yield* failStaleInvestigations(orgId, nowMs)
						if (request.subject.type === "incident") {
							const existing = yield* loadIncidentRow(
								orgId,
								request.subject.incidentKind,
								request.subject.incidentId,
							)
							if (
								existing &&
								(existing.status !== "investigating" || existing.startedAt !== null)
							) {
								return yield* documentFor(orgId, existing)
							}
						}
						const doc = yield* createInvestigation(orgId, userId, request)
						const claimed = yield* dbExecute((db) =>
							db
								.update(investigations)
								.set({
									startedAt: new Date(nowMs),
									autonomousTurns: sql`${investigations.autonomousTurns} + 1`,
									updatedAt: new Date(nowMs),
								})
								.where(
									and(
										eq(investigations.orgId, orgId),
										eq(investigations.id, doc.id),
										eq(investigations.status, "investigating"),
										isNull(investigations.startedAt),
									),
								)
								.returning({ id: investigations.id }),
						)
						if (claimed.length === 0) return doc
						yield* sendAutonomousTurn(orgId, doc, nowMs)
						return yield* getInvestigation(orgId, doc.id).pipe(
							Effect.catchTag("@maple/http/investigations/InvestigationNotFoundError", () =>
								Effect.fail(
									new InvestigationPersistenceError({
										message: "Investigation row disappeared after autonomous start",
									}),
								),
							),
						)
					},
				)

			const restartInvestigation: InvestigationServiceApi["restartInvestigation"] = Effect.fn(
				"InvestigationService.restartInvestigation",
			)(function* (orgId, id) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.investigation.id": id })
				const nowMs = yield* Clock.currentTimeMillis
				const existing = yield* getInvestigation(orgId, id)
				yield* dbExecute((db) =>
					db
						.update(investigations)
						.set({
							status: "investigating",
							error: null,
							startedAt: new Date(nowMs),
							autonomousTurns: sql`${investigations.autonomousTurns} + 1`,
							updatedAt: new Date(nowMs),
						})
						.where(and(eq(investigations.orgId, orgId), eq(investigations.id, id))),
				)
				const restarting = new InvestigationDocument({
					...existing,
					status: "investigating",
					error: null,
					updatedAt: decodeIsoSync(new Date(nowMs).toISOString()),
				})
				yield* sendAutonomousTurn(orgId, restarting, nowMs)
				return yield* getInvestigation(orgId, id)
			})

			const updateStatus: InvestigationServiceApi["updateStatus"] = Effect.fn(
				"InvestigationService.updateStatus",
			)(function* (orgId, id, status) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.investigation.id": id,
					"maple.investigation.status": status,
				})
				const nowMs = yield* Clock.currentTimeMillis
				const updated = yield* dbExecute((db) =>
					db
						.update(investigations)
						.set({ status, updatedAt: new Date(nowMs) })
						.where(and(eq(investigations.orgId, orgId), eq(investigations.id, id)))
						.returning({ id: investigations.id }),
				)
				if (updated.length === 0) {
					return yield* Effect.fail(
						new InvestigationNotFoundError({ message: `No such investigation: '${id}'` }),
					)
				}
				const row = yield* loadRow(orgId, id)
				if (!row) {
					return yield* Effect.fail(
						new InvestigationNotFoundError({ message: `No such investigation: '${id}'` }),
					)
				}
				return yield* documentFor(orgId, row)
			})

			/**
			 * The `submit_diagnosis` write path. Persists the structured
			 * report onto the investigation row, then applies the incident-side
			 * effects (severity + issue timeline) and tracks token usage — all
			 * idempotent on the investigation id so a re-diagnosis or retry can't
			 * duplicate them.
			 */
			const submitDiagnosis: InvestigationServiceApi["submitDiagnosis"] = Effect.fn(
				"InvestigationService.submitDiagnosis",
			)(function* (orgId, id, request) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.investigation.id": id })
				const nowMs = yield* Clock.currentTimeMillis
				const row = yield* loadRow(orgId, id)
				if (!row) {
					return yield* Effect.fail(
						new InvestigationNotFoundError({ message: `No such investigation: '${id}'` }),
					)
				}

				const result = request.report
				const confidence: InvestigationConfidence = result.confidence

				// Shared with the fan-out workflow's `persist` step so a diagnosis means
				// the same thing whichever path produced it — same status transition, same
				// severity application, same deterministically-keyed timeline event.
				// `provideService(Database, database)`: the shared writer carries Database
				// in R, while this service's API effects are R = never. `mapError` keeps
				// this method's persistence-error channel — the writer stays neutral
				// because the fan-out workflow maps it differently.
				yield* applyDiagnosisWrites({
					orgId,
					investigationId: id,
					report: result,
					issueId: row.issueId ?? null,
					subjectType: subjectTypeOf(row.subjectJson),
					model: request.model ?? row.model ?? null,
					inputTokens: request.inputTokens ?? row.inputTokens ?? null,
					outputTokens: request.outputTokens ?? row.outputTokens ?? null,
					nowMs,
				}).pipe(Effect.mapError(makePersistenceError), Effect.provideService(Database, database))

				// Deliberately does NOT meter. `request.inputTokens`/`outputTokens` are persisted onto
				// the row above for display, but the charge is raised per *turn* in
				// `chat/turn-runner.ts` — see `meterTurn`. Every caller that supplies usage here is a
				// chat-session turn, and the runner meters that turn in full, including whatever it
				// spends after this call. Metering here as well double-billed the turn; metering here
				// *instead* under-billed it, because this key is the investigation id: a superseding
				// diagnosis deduplicates against the first, so every follow-up turn (and every turn
				// that failed before reaching this tool) was free. This path also carries no usage at
				// all when reached over internal RPC, which never populates those fields.

				const updated = yield* loadRow(orgId, id)
				return yield* documentFor(orgId, updated ?? row)
			})

			const failInvestigation: InvestigationServiceApi["failInvestigation"] = Effect.fn(
				"InvestigationService.failInvestigation",
			)(function* (orgId, id, error) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.investigation.id": id })
				const nowMs = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db
						.update(investigations)
						.set({ status: "failed", error, updatedAt: new Date(nowMs) })
						.where(
							and(
								eq(investigations.orgId, orgId),
								eq(investigations.id, id),
								eq(investigations.status, "investigating"),
							),
						),
				)
			})

			return {
				listInvestigations,
				getInvestigation,
				createInvestigation,
				createAndStartInvestigation,
				restartInvestigation,
				updateStatus,
				submitDiagnosis,
				failInvestigation,
			} satisfies InvestigationServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
