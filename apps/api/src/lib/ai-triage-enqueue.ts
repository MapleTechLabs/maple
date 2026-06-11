import { randomUUID } from "node:crypto"
import type { AiTriageIncidentKind, ErrorIssueId, OrgId } from "@maple/domain/http"
import { AiTriageRunId } from "@maple/domain/primitives"
import { aiTriageRuns, aiTriageSettings, type AiTriageSettingsRow } from "@maple/db"
import { and, eq, gte, sql } from "drizzle-orm"
import { Cause, Clock, Data, Effect, Schema } from "effect"
import { Database } from "./DatabaseLive"

// Cloudflare Workflow binding that runs the headless triage agent. Hosted by
// the api worker; the alerting worker reaches it via a cross-script binding.
export const AI_TRIAGE_WORKFLOW_BINDING = "AI_TRIAGE_WORKFLOW"

export interface AiTriageWorkflowParams {
	readonly orgId: string
	readonly incidentKind: AiTriageIncidentKind
	readonly incidentId: string
	readonly issueId?: string
	readonly runId: string
}

interface WorkflowBinding {
	readonly create: (options?: {
		readonly id?: string
		readonly params?: AiTriageWorkflowParams
	}) => Promise<unknown>
}

export const isAiTriageWorkflowBinding = (value: unknown): value is WorkflowBinding =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { create?: unknown }).create === "function"

const decodeRunIdSync = Schema.decodeUnknownSync(AiTriageRunId)

export const newAiTriageRunId = () => decodeRunIdSync(randomUUID())

export const startOfUtcDay = (nowMs: number): number => {
	const date = new Date(nowMs)
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

export interface MaybeEnqueueTriageInput {
	readonly orgId: OrgId
	readonly incidentKind: AiTriageIncidentKind
	readonly incidentId: string
	readonly issueId?: ErrorIssueId
	/** Incident context blob the agent prompt is built from (kind-specific). */
	readonly context: Record<string, unknown>
	/**
	 * Raw AI_TRIAGE_WORKFLOW binding value off the worker env, captured by the
	 * calling service at construction (Effect.serviceOption(WorkerEnvironment)).
	 * Undefined outside a Worker isolate — the run row is marked failed then.
	 */
	readonly workflowBinding: unknown
	/** Skip the per-org enabled flag (manual "Run triage" requests). */
	readonly force?: boolean
}

export interface MaybeEnqueueTriageResult {
	readonly enqueued: boolean
	readonly runId?: AiTriageRunId
	readonly reason?: "disabled" | "daily_cap" | "duplicate" | "no_binding" | "error"
}

class AiTriageWorkflowCreateError extends Data.TaggedError("AiTriageWorkflowCreateError")<{
	readonly message: string
	readonly cause: unknown
}> {}

/**
 * Gate, record, and kick off an AI triage run for a freshly opened incident.
 *
 * Never fails: every error path is logged and reported via `reason` so the
 * calling tick (ErrorsService / AnomalyDetectionService) is isolated from
 * triage problems. Dedup is enforced by the unique
 * (orgId, incidentKind, incidentId) index on ai_triage_runs plus the
 * workflow-instance id.
 */
export const maybeEnqueueTriage: (
	input: MaybeEnqueueTriageInput,
) => Effect.Effect<MaybeEnqueueTriageResult, never, Database> = Effect.fn("maybeEnqueueTriage")(
	function* (input: MaybeEnqueueTriageInput) {
		const database = yield* Database
		const nowMs = yield* Clock.currentTimeMillis

		const settingsRows = yield* database.execute((db) =>
			db.select().from(aiTriageSettings).where(eq(aiTriageSettings.orgId, input.orgId)).limit(1),
		)
		const settings: AiTriageSettingsRow | undefined = settingsRows[0]
		if (!input.force && (settings === undefined || settings.enabled !== 1)) {
			return { enqueued: false, reason: "disabled" as const }
		}

		const maxRunsPerDay = settings?.maxRunsPerDay ?? 20
		const todayCount = yield* database.execute((db) =>
			db
				.select({ count: sql<number>`count(*)` })
				.from(aiTriageRuns)
				.where(
					and(
						eq(aiTriageRuns.orgId, input.orgId),
						gte(aiTriageRuns.createdAt, startOfUtcDay(nowMs)),
					),
				),
		)
		if ((todayCount[0]?.count ?? 0) >= maxRunsPerDay) {
			yield* Effect.logWarning("AI triage daily cap reached; skipping run").pipe(
				Effect.annotateLogs({ orgId: input.orgId, incidentId: input.incidentId, maxRunsPerDay }),
			)
			return { enqueued: false, reason: "daily_cap" as const }
		}

		const runId = newAiTriageRunId()
		const inserted = yield* database.execute((db) =>
			db
				.insert(aiTriageRuns)
				.values({
					id: runId,
					orgId: input.orgId,
					incidentKind: input.incidentKind,
					incidentId: input.incidentId,
					issueId: input.issueId ?? null,
					status: "queued",
					contextJson: JSON.stringify(input.context),
					createdAt: nowMs,
					updatedAt: nowMs,
				})
				.onConflictDoNothing(),
		)
		if ((inserted as { rowsAffected?: number }).rowsAffected === 0) {
			return { enqueued: false, reason: "duplicate" as const }
		}

		const binding = input.workflowBinding
		if (!isAiTriageWorkflowBinding(binding)) {
			yield* Effect.logWarning("AI triage workflow binding unavailable; marking run failed").pipe(
				Effect.annotateLogs({ orgId: input.orgId, runId }),
			)
			yield* database.execute((db) =>
				db
					.update(aiTriageRuns)
					.set({ status: "failed", error: "workflow_binding_unavailable", updatedAt: nowMs })
					.where(eq(aiTriageRuns.id, runId)),
			)
			return { enqueued: false, runId, reason: "no_binding" as const }
		}

		yield* Effect.tryPromise({
			try: () =>
				binding.create({
					id: runId,
					params: {
						orgId: input.orgId,
						incidentKind: input.incidentKind,
						incidentId: input.incidentId,
						issueId: input.issueId,
						runId,
					},
				}),
			catch: (error) =>
				new AiTriageWorkflowCreateError({
					message: error instanceof Error ? error.message : String(error),
					cause: error,
				}),
		}).pipe(
			Effect.tapError((error) =>
				database
					.execute((db) =>
						db
							.update(aiTriageRuns)
							.set({
								status: "failed",
								error: `workflow_create_failed: ${error.message}`,
								updatedAt: nowMs,
							})
							.where(eq(aiTriageRuns.id, runId)),
					)
					.pipe(Effect.ignore),
			),
		)

		return { enqueued: true, runId }
	},
	(effect, input) =>
		Effect.catchCause(effect, (cause) =>
			Effect.gen(function* () {
				yield* Effect.logError("AI triage enqueue failed").pipe(
					Effect.annotateLogs({
						orgId: input.orgId,
						incidentKind: input.incidentKind,
						incidentId: input.incidentId,
						error: Cause.pretty(cause),
					}),
				)
				return { enqueued: false, reason: "error" as const }
			}),
		),
)
