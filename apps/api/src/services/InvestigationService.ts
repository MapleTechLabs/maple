import { createHash, randomUUID } from "node:crypto"
import {
	type AiTriageIncidentKind,
	AiTriageResult,
	type InvestigationConfidence,
	InvestigationCreateRequest,
	InvestigationDocument,
	InvestigationNotFoundError,
	InvestigationPersistenceError,
	InvestigationsListResponse,
	type InvestigationStatus,
	InvestigationSubject,
	type OrgId,
	type SubmitDiagnosisRequest,
	type UserId,
} from "@maple/domain/http"
import { ErrorIssueEventId, ErrorIssueId, InvestigationId } from "@maple/domain/primitives"
import { errorIssueEvents, investigations, type InvestigationRow } from "@maple/db"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { and, desc, eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { trackTokenUsage } from "../lib/autumn-tracker"
import { applyTriageSeverity } from "../lib/issue-severity"
import { Database, DatabaseError, type DatabaseClient } from "../lib/DatabaseLive"

const decodeIdSync = Schema.decodeUnknownSync(InvestigationId)
const decodeSubjectSync = Schema.decodeUnknownSync(InvestigationSubject)
const decodeResultSync = Schema.decodeUnknownSync(AiTriageResult)
const decodeIsoSync = Schema.decodeUnknownSync(InvestigationDocument.fields.createdAt)
const decodeIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const decodeEventId = Schema.decodeUnknownSync(ErrorIssueEventId)

export const newInvestigationId = () => decodeIdSync(randomUUID())

/**
 * Deterministic UUIDv5-style id derived from the investigation id, so the
 * `submit_diagnosis` timeline-event insert is idempotent across re-diagnosis:
 * the same investigation regenerates the SAME id and the primary key (+
 * onConflictDoNothing) absorbs the duplicate. Mirrors the legacy triage path.
 */
const deterministicEventId = (investigationId: string): string => {
	const hex = createHash("sha256").update(`investigation-event:${investigationId}`).digest("hex")
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`5${hex.slice(13, 16)}`,
		`${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
		hex.slice(20, 32),
	].join("-")
}

const describeCause = (cause: unknown): string | undefined => {
	if (cause == null) return undefined
	if (cause instanceof Error) return cause.stack ?? cause.message
	if (typeof cause === "string") return cause
	try {
		return JSON.stringify(cause)
	} catch {
		return String(cause)
	}
}

const makePersistenceError = (error: unknown): InvestigationPersistenceError => {
	const message =
		error instanceof DatabaseError || error instanceof Error
			? error.message
			: "Investigation persistence failure"
	const cause = describeCause(error instanceof Error ? error.cause : error)
	return cause === undefined
		? new InvestigationPersistenceError({ message })
		: new InvestigationPersistenceError({ message, cause })
}

export interface ListInvestigationsOptions {
	readonly issueId?: ErrorIssueId
	readonly incidentKind?: AiTriageIncidentKind
	readonly incidentId?: string
	readonly status?: InvestigationStatus
	readonly limit?: number
}

export interface InvestigationServiceShape {
	readonly listInvestigations: (
		orgId: OrgId,
		opts: ListInvestigationsOptions,
	) => Effect.Effect<InvestigationsListResponse, InvestigationPersistenceError>
	readonly getInvestigation: (
		orgId: OrgId,
		id: InvestigationId,
	) => Effect.Effect<InvestigationDocument, InvestigationPersistenceError | InvestigationNotFoundError>
	readonly createInvestigation: (
		orgId: OrgId,
		userId: UserId | null,
		request: InvestigationCreateRequest,
	) => Effect.Effect<InvestigationDocument, InvestigationPersistenceError>
	readonly updateStatus: (
		orgId: OrgId,
		id: InvestigationId,
		status: InvestigationStatus,
	) => Effect.Effect<InvestigationDocument, InvestigationPersistenceError | InvestigationNotFoundError>
	readonly submitDiagnosis: (
		orgId: OrgId,
		id: InvestigationId,
		request: SubmitDiagnosisRequest,
	) => Effect.Effect<InvestigationDocument, InvestigationPersistenceError | InvestigationNotFoundError>
}

export class InvestigationService extends Context.Service<InvestigationService, InvestigationServiceShape>()(
	"@maple/api/services/InvestigationService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const workerEnv = yield* Effect.serviceOption(WorkerEnvironment)

			const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
				database.execute(fn).pipe(Effect.mapError(makePersistenceError))

			const iso = (date: Date) => decodeIsoSync(date.toISOString())

			const parseReport = (raw: unknown): AiTriageResult | null => {
				if (raw == null) return null
				try {
					return decodeResultSync(raw)
				} catch {
					return null
				}
			}

			const rowToDocument = (row: InvestigationRow): InvestigationDocument =>
				new InvestigationDocument({
					id: decodeIdSync(row.id),
					status: row.status,
					subject: decodeSubjectSync(row.subjectJson),
					report: parseReport(row.reportJson),
					model: row.model ?? null,
					severity: row.severity ?? null,
					confidence: row.confidence ?? null,
					seededBy: row.seededBy,
					createdBy: row.createdBy ?? null,
					inputTokens: row.inputTokens ?? null,
					outputTokens: row.outputTokens ?? null,
					error: row.error ?? null,
					createdAt: iso(row.createdAt),
					diagnosedAt: row.diagnosedAt ? iso(row.diagnosedAt) : null,
					updatedAt: iso(row.updatedAt),
				})

			const loadRow = (orgId: OrgId, id: InvestigationId) =>
				dbExecute((db) =>
					db
						.select()
						.from(investigations)
						.where(and(eq(investigations.orgId, orgId), eq(investigations.id, id)))
						.limit(1),
				).pipe(Effect.map((rows) => rows[0]))

			const listInvestigations: InvestigationServiceShape["listInvestigations"] = Effect.fn(
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
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(investigations)
						.where(and(...conditions))
						.orderBy(desc(investigations.createdAt))
						.limit(opts.limit ?? 50),
				)
				return new InvestigationsListResponse({ investigations: rows.map(rowToDocument) })
			})

			const getInvestigation: InvestigationServiceShape["getInvestigation"] = Effect.fn(
				"InvestigationService.getInvestigation",
			)(function* (orgId, id) {
				yield* Effect.annotateCurrentSpan({ orgId, investigationId: id })
				const row = yield* loadRow(orgId, id)
				if (!row) {
					return yield* Effect.fail(
						new InvestigationNotFoundError({ message: `No such investigation: '${id}'` }),
					)
				}
				return rowToDocument(row)
			})

			const createInvestigation: InvestigationServiceShape["createInvestigation"] = Effect.fn(
				"InvestigationService.createInvestigation",
			)(function* (orgId, userId, request) {
				yield* Effect.annotateCurrentSpan({ orgId, subjectType: request.subject.type })
				const nowMs = yield* Clock.currentTimeMillis
				const subject = request.subject

				// Incident-anchored investigations dedup to one row per incident: if one
				// already exists, return it (re-opening the same war-room) instead of
				// creating a duplicate. Free-form investigations are always new.
				if (subject.type === "incident") {
					const existing = yield* dbExecute((db) =>
						db
							.select()
							.from(investigations)
							.where(
								and(
									eq(investigations.orgId, orgId),
									eq(investigations.incidentKind, subject.incidentKind),
									eq(investigations.incidentId, subject.incidentId),
								),
							)
							.limit(1),
					)
					if (existing[0]) return rowToDocument(existing[0])
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

				yield* dbExecute((db) =>
					db.insert(investigations).values({
						id,
						orgId,
						status: "investigating",
						seededBy: userId ? "user" : "system",
						subjectJson: subject,
						...incidentColumns,
						createdBy: userId,
						createdAt: new Date(nowMs),
						updatedAt: new Date(nowMs),
					}),
				)

				const row = yield* loadRow(orgId, id)
				if (!row) {
					return yield* Effect.fail(
						new InvestigationPersistenceError({ message: "Investigation row missing after insert" }),
					)
				}
				return rowToDocument(row)
			})

			const updateStatus: InvestigationServiceShape["updateStatus"] = Effect.fn(
				"InvestigationService.updateStatus",
			)(function* (orgId, id, status) {
				yield* Effect.annotateCurrentSpan({ orgId, investigationId: id, status })
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
				return rowToDocument(row)
			})

			/**
			 * The chat-flue `submit_diagnosis` write path. Persists the structured
			 * report onto the investigation row, then applies the incident-side
			 * effects (severity + issue timeline) and tracks token usage — all
			 * idempotent on the investigation id so a re-diagnosis or retry can't
			 * duplicate them. Ported from the legacy AiTriageWorkflow persist step.
			 */
			const submitDiagnosis: InvestigationServiceShape["submitDiagnosis"] = Effect.fn(
				"InvestigationService.submitDiagnosis",
			)(function* (orgId, id, request) {
				yield* Effect.annotateCurrentSpan({ orgId, investigationId: id })
				const nowMs = yield* Clock.currentTimeMillis
				const row = yield* loadRow(orgId, id)
				if (!row) {
					return yield* Effect.fail(
						new InvestigationNotFoundError({ message: `No such investigation: '${id}'` }),
					)
				}

				const result = request.report
				const confidence: InvestigationConfidence = result.confidence

				yield* dbExecute((db) =>
					db
						.update(investigations)
						.set({
							status: "diagnosed",
							reportJson: result,
							severity: result.severityAssessment,
							confidence,
							model: request.model ?? row.model ?? null,
							inputTokens: request.inputTokens ?? row.inputTokens ?? null,
							outputTokens: request.outputTokens ?? row.outputTokens ?? null,
							error: null,
							diagnosedAt: new Date(nowMs),
							updatedAt: new Date(nowMs),
						})
						.where(and(eq(investigations.orgId, orgId), eq(investigations.id, id))),
				)

				// Linked error issue (error fingerprint / alert-backed / anomaly-linked)
				// gets the diagnosis applied: severity (respecting manual override) +
				// a timeline event, both idempotent via the investigation-derived ids.
				const issueId = row.issueId
				if (issueId) {
					const decodedIssueId = decodeIssueId(issueId)
					const applied = yield* dbExecute((db) =>
						applyTriageSeverity(db, {
							orgId,
							issueId: decodedIssueId,
							runId: id,
							severity: result.severityAssessment,
							confidence,
							timestamp: nowMs,
							result,
						}),
					)
					yield* dbExecute((db) =>
						db
							.insert(errorIssueEvents)
							.values({
								id: decodeEventId(deterministicEventId(id)),
								orgId,
								issueId: decodedIssueId,
								actorId: applied.actorId,
								type: "ai_triage",
								payloadJson: {
									investigationId: id,
									summary: result.summary,
									severityAssessment: result.severityAssessment,
									confidence,
									applied: applied.applied,
								},
								createdAt: new Date(nowMs),
							})
							.onConflictDoNothing(),
					)
				}

				const env = Option.getOrUndefined(workerEnv)
				if (env && (request.inputTokens || request.outputTokens)) {
					yield* Effect.tryPromise({
						try: () =>
							trackTokenUsage(env, {
								orgId,
								inputTokens: request.inputTokens ?? 0,
								outputTokens: request.outputTokens ?? 0,
								idempotencyKey: id,
								source: "triage",
							}),
						catch: makePersistenceError,
					}).pipe(Effect.ignore)
				}

				const updated = yield* loadRow(orgId, id)
				return rowToDocument(updated ?? row)
			})

			return {
				listInvestigations,
				getInvestigation,
				createInvestigation,
				updateStatus,
				submitDiagnosis,
			} satisfies InvestigationServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
