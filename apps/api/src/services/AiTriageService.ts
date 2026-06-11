import {
	type AiTriageIncidentKind,
	AiTriageNotFoundError,
	AiTriagePersistenceError,
	AiTriageResult,
	AiTriageRunDocument,
	type AiTriageRunCreateRequest,
	AiTriageRunsListResponse,
	AiTriageSettingsDocument,
	type AiTriageSettingsUpdateRequest,
	AiTriageValidationError,
	AnomalyIncidentId,
	ErrorIncidentId,
	type ErrorIssueId,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import {
	aiTriageRuns,
	type AiTriageRunRow,
	aiTriageSettings,
	type AiTriageSettingsRow,
	anomalyIncidents,
	errorIncidents,
	errorIssues,
	orgOpenrouterSettings,
} from "@maple/db"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { and, desc, eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database, DatabaseError, type DatabaseClient } from "../lib/DatabaseLive"
import {
	AI_TRIAGE_WORKFLOW_BINDING,
	isAiTriageWorkflowBinding,
	newAiTriageRunId,
} from "../lib/ai-triage-enqueue"

const decodeIsoSync = Schema.decodeUnknownSync(AiTriageRunDocument.fields.createdAt)
const decodeResultSync = Schema.decodeUnknownSync(AiTriageResult)
const decodeAnomalyIncidentId = Schema.decodeUnknownOption(AnomalyIncidentId)
const decodeErrorIncidentId = Schema.decodeUnknownOption(ErrorIncidentId)

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

const makePersistenceError = (error: unknown): AiTriagePersistenceError => {
	const message =
		error instanceof DatabaseError || error instanceof Error
			? error.message
			: "AI triage persistence failure"
	const cause = describeCause(error instanceof Error ? error.cause : error)
	return cause === undefined
		? new AiTriagePersistenceError({ message })
		: new AiTriagePersistenceError({ message, cause })
}

export interface AiTriageServiceShape {
	readonly getSettings: (
		orgId: OrgId,
	) => Effect.Effect<AiTriageSettingsDocument, AiTriagePersistenceError>
	readonly updateSettings: (
		orgId: OrgId,
		userId: UserId,
		request: AiTriageSettingsUpdateRequest,
	) => Effect.Effect<AiTriageSettingsDocument, AiTriagePersistenceError | AiTriageValidationError>
	readonly listRuns: (
		orgId: OrgId,
		opts: {
			readonly issueId?: ErrorIssueId
			readonly incidentId?: string
			readonly incidentKind?: AiTriageIncidentKind
			readonly limit?: number
		},
	) => Effect.Effect<AiTriageRunsListResponse, AiTriagePersistenceError>
	readonly createRun: (
		orgId: OrgId,
		request: AiTriageRunCreateRequest,
	) => Effect.Effect<
		AiTriageRunDocument,
		AiTriagePersistenceError | AiTriageValidationError | AiTriageNotFoundError
	>
}

export class AiTriageService extends Context.Service<AiTriageService, AiTriageServiceShape>()(
	"@maple/api/services/AiTriageService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const workerEnv = yield* Effect.serviceOption(WorkerEnvironment)

			const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
				database.execute(fn).pipe(Effect.mapError(makePersistenceError))

			const isoFromEpoch = (ms: number) => decodeIsoSync(new Date(ms).toISOString())

			const parseResult = (raw: string | null): AiTriageResult | null => {
				if (raw == null) return null
				try {
					return decodeResultSync(JSON.parse(raw))
				} catch {
					return null
				}
			}

			const runToDocument = (row: AiTriageRunRow): AiTriageRunDocument =>
				new AiTriageRunDocument({
					id: Schema.decodeUnknownSync(AiTriageRunDocument.fields.id)(row.id),
					incidentKind: row.incidentKind,
					incidentId: row.incidentId,
					issueId: row.issueId ?? null,
					status: row.status,
					result: parseResult(row.resultJson),
					model: row.model ?? null,
					inputTokens: row.inputTokens ?? null,
					outputTokens: row.outputTokens ?? null,
					error: row.error ?? null,
					createdAt: isoFromEpoch(row.createdAt),
					startedAt: row.startedAt ? isoFromEpoch(row.startedAt) : null,
					completedAt: row.completedAt ? isoFromEpoch(row.completedAt) : null,
				})

			const loadSettingsRow = Effect.fn("AiTriageService.loadSettingsRow")(function* (
				orgId: OrgId,
			) {
				const rows = yield* dbExecute((db) =>
					db.select().from(aiTriageSettings).where(eq(aiTriageSettings.orgId, orgId)).limit(1),
				)
				return rows[0]
			})

			const settingsToDocument = (
				row: AiTriageSettingsRow | undefined,
			): AiTriageSettingsDocument =>
				new AiTriageSettingsDocument({
					enabled: row?.enabled === 1,
					modelOverride: row?.modelOverride ?? null,
					maxRunsPerDay: row?.maxRunsPerDay ?? 20,
					updatedAt: row?.updatedAt ? isoFromEpoch(row.updatedAt) : null,
					updatedBy: row?.updatedBy ?? null,
				})

			const getSettings: AiTriageServiceShape["getSettings"] = Effect.fn(
				"AiTriageService.getSettings",
			)(function* (orgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				return settingsToDocument(yield* loadSettingsRow(orgId))
			})

			const hasOpenRouterKey = Effect.fn("AiTriageService.hasOpenRouterKey")(function* (
				orgId: OrgId,
			) {
				const rows = yield* dbExecute((db) =>
					db
						.select({ orgId: orgOpenrouterSettings.orgId })
						.from(orgOpenrouterSettings)
						.where(eq(orgOpenrouterSettings.orgId, orgId))
						.limit(1),
				)
				return rows.length > 0
			})

			const updateSettings: AiTriageServiceShape["updateSettings"] = Effect.fn(
				"AiTriageService.updateSettings",
			)(function* (orgId, userId, request) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const nowMs = yield* Clock.currentTimeMillis
				const existing = yield* loadSettingsRow(orgId)

				const nextEnabled =
					request.enabled === undefined ? (existing?.enabled ?? 0) : request.enabled ? 1 : 0
				if (nextEnabled === 1 && !(yield* hasOpenRouterKey(orgId))) {
					return yield* Effect.fail(
						new AiTriageValidationError({
							message:
								"AI triage needs an OpenRouter API key. Configure one under AI settings first.",
						}),
					)
				}

				const next = {
					enabled: nextEnabled,
					modelOverride:
						request.modelOverride === undefined
							? (existing?.modelOverride ?? null)
							: request.modelOverride,
					maxRunsPerDay: request.maxRunsPerDay ?? existing?.maxRunsPerDay ?? 20,
					updatedAt: nowMs,
					updatedBy: userId,
				}
				yield* dbExecute((db) =>
					db
						.insert(aiTriageSettings)
						.values({ orgId, ...next })
						.onConflictDoUpdate({ target: aiTriageSettings.orgId, set: next }),
				)
				return settingsToDocument(yield* loadSettingsRow(orgId))
			})

			const listRuns: AiTriageServiceShape["listRuns"] = Effect.fn("AiTriageService.listRuns")(
				function* (orgId, opts) {
					yield* Effect.annotateCurrentSpan({ orgId })
					const conditions = [
						eq(aiTriageRuns.orgId, orgId),
						opts.issueId ? eq(aiTriageRuns.issueId, opts.issueId) : undefined,
						opts.incidentId ? eq(aiTriageRuns.incidentId, opts.incidentId) : undefined,
						opts.incidentKind ? eq(aiTriageRuns.incidentKind, opts.incidentKind) : undefined,
					].filter((c): c is NonNullable<typeof c> => c !== undefined)
					const rows = yield* dbExecute((db) =>
						db
							.select()
							.from(aiTriageRuns)
							.where(and(...conditions))
							.orderBy(desc(aiTriageRuns.createdAt))
							.limit(opts.limit ?? 20),
					)
					return new AiTriageRunsListResponse({ runs: rows.map(runToDocument) })
				},
			)

			/**
			 * Build the prompt context blob for a manual run from the incident rows.
			 * The automatic path (ErrorsService / AnomalyDetectionService) builds
			 * richer context inline at incident-open time.
			 */
			const buildContext = Effect.fn("AiTriageService.buildContext")(function* (
				orgId: OrgId,
				request: AiTriageRunCreateRequest,
			) {
				if (request.incidentKind === "anomaly") {
					const incidentId = Option.getOrUndefined(decodeAnomalyIncidentId(request.incidentId))
					const rows = incidentId
						? yield* dbExecute((db) =>
								db
									.select()
									.from(anomalyIncidents)
									.where(
										and(eq(anomalyIncidents.orgId, orgId), eq(anomalyIncidents.id, incidentId)),
									)
									.limit(1),
							)
						: []
					const incident = rows[0]
					if (!incident) {
						return yield* Effect.fail(
							new AiTriageNotFoundError({
								message: `No such anomaly incident: '${request.incidentId}'`,
							}),
						)
					}
					return {
						issueId: undefined as ErrorIssueId | undefined,
						context: {
							kind: "anomaly",
							signalType: incident.signalType,
							serviceName: incident.serviceName,
							deploymentEnv: incident.deploymentEnv,
							fingerprintHash: incident.fingerprintHash,
							severity: incident.severity,
							openedValue: incident.openedValue,
							baselineMedian: incident.baselineMedian,
							baselineSigma: incident.baselineSigma,
							thresholdValue: incident.thresholdValue,
							firstTriggeredAt: new Date(incident.firstTriggeredAt).toISOString(),
							lastTriggeredAt: new Date(incident.lastTriggeredAt).toISOString(),
							status: incident.status,
						},
					}
				}

				const errorIncidentId = Option.getOrUndefined(decodeErrorIncidentId(request.incidentId))
				const incidentRows = errorIncidentId
					? yield* dbExecute((db) =>
							db
								.select()
								.from(errorIncidents)
								.where(and(eq(errorIncidents.orgId, orgId), eq(errorIncidents.id, errorIncidentId)))
								.limit(1),
						)
					: []
				const incident = incidentRows[0]
				if (!incident) {
					return yield* Effect.fail(
						new AiTriageNotFoundError({
							message: `No such error incident: '${request.incidentId}'`,
						}),
					)
				}
				const issueRows = yield* dbExecute((db) =>
					db
						.select()
						.from(errorIssues)
						.where(and(eq(errorIssues.orgId, orgId), eq(errorIssues.id, incident.issueId)))
						.limit(1),
				)
				const issue = issueRows[0]
				return {
					issueId: incident.issueId,
					context: {
						kind: "error",
						reason: incident.reason,
						serviceName: issue?.serviceName,
						exceptionType: issue?.exceptionType,
						exceptionMessage: issue?.exceptionMessage,
						errorLabel: issue?.errorLabel,
						topFrame: issue?.topFrame,
						fingerprintHash: issue?.fingerprintHash,
						occurrenceCount: incident.occurrenceCount,
						firstTriggeredAt: new Date(incident.firstTriggeredAt).toISOString(),
						lastTriggeredAt: new Date(incident.lastTriggeredAt).toISOString(),
						issueId: incident.issueId,
					},
				}
			})

			const createRun: AiTriageServiceShape["createRun"] = Effect.fn("AiTriageService.createRun")(
				function* (orgId, request) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						incidentKind: request.incidentKind,
						incidentId: request.incidentId,
					})
					const nowMs = yield* Clock.currentTimeMillis

					if (!(yield* hasOpenRouterKey(orgId))) {
						return yield* Effect.fail(
							new AiTriageValidationError({
								message:
									"AI triage needs an OpenRouter API key. Configure one under AI settings first.",
							}),
						)
					}

					const { issueId, context } = yield* buildContext(orgId, request)

					// Manual re-run: replace any prior run for this incident.
					yield* dbExecute((db) =>
						db
							.delete(aiTriageRuns)
							.where(
								and(
									eq(aiTriageRuns.orgId, orgId),
									eq(aiTriageRuns.incidentKind, request.incidentKind),
									eq(aiTriageRuns.incidentId, request.incidentId),
								),
							),
					)

					const runId = newAiTriageRunId()
					yield* dbExecute((db) =>
						db.insert(aiTriageRuns).values({
							id: runId,
							orgId,
							incidentKind: request.incidentKind,
							incidentId: request.incidentId,
							issueId: request.issueId ?? issueId ?? null,
							status: "queued",
							contextJson: JSON.stringify(context),
							createdAt: nowMs,
							updatedAt: nowMs,
						}),
					)

					const binding = Option.match(workerEnv, {
						onNone: () => undefined,
						onSome: (e) => e[AI_TRIAGE_WORKFLOW_BINDING],
					})
					if (!isAiTriageWorkflowBinding(binding)) {
						yield* dbExecute((db) =>
							db
								.update(aiTriageRuns)
								.set({ status: "failed", error: "workflow_binding_unavailable", updatedAt: nowMs })
								.where(eq(aiTriageRuns.id, runId)),
						)
					} else {
						yield* Effect.tryPromise({
							try: () =>
								binding.create({
									id: runId,
									params: {
										orgId,
										incidentKind: request.incidentKind,
										incidentId: request.incidentId,
										issueId: request.issueId ?? issueId,
										runId,
									},
								}),
							catch: (error) =>
								new AiTriagePersistenceError({
									message: `Failed to start AI triage workflow: ${error instanceof Error ? error.message : String(error)}`,
								}),
						})
					}

					const rows = yield* dbExecute((db) =>
						db.select().from(aiTriageRuns).where(eq(aiTriageRuns.id, runId)).limit(1),
					)
					const row = rows[0]
					if (!row) {
						return yield* Effect.fail(
							new AiTriagePersistenceError({ message: "Triage run row missing after insert" }),
						)
					}
					return runToDocument(row)
				},
			)

			return {
				getSettings,
				updateSettings,
				listRuns,
				createRun,
			} satisfies AiTriageServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
