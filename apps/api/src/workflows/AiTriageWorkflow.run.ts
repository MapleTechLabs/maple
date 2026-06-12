/**
 * Headless AI triage workflow logic (heavy import graph lives here, NOT in the
 * thin class shell — see the dynamic import in `AiTriageWorkflow.ts`).
 *
 * Investigates a freshly opened incident (error or anomaly) with a read-only
 * subset of the Maple tool registry driven by `generateText`, and persists a
 * structured triage result onto `ai_triage_runs` (+ the error-issue timeline).
 *
 * Step layout:
 *   1. gate-and-claim — replay guard, settings re-check, OpenRouter key check
 *   2. run-agent      — the whole agent loop in ONE durable step (I/O-bound;
 *                       splitting per LLM round would push the growing message
 *                       array through the 1 MiB step-output cap for no benefit)
 *   3. persist        — run row + issue timeline + usage tracking
 */
import { createHash } from "node:crypto"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { generateText, hasToolCall, stepCountIs, type ToolSet } from "ai"
import { aiTriageRuns, aiTriageSettings, anomalyIncidents, errorIssueEvents } from "@maple/db"
import { createMaplePgClient, type MaplePgClient } from "@maple/db/client"
import { AiTriageResult } from "@maple/domain/http"
import {
	AiTriageRunId,
	AnomalyIncidentId,
	ErrorIssueEventId,
	ErrorIssueId,
	OrgId,
} from "@maple/domain/primitives"
import { and, eq } from "drizzle-orm"
import { Cause, Data, Effect, Exit, Option, Schema } from "effect"
import { getMapleAgentSetup, resolveOrgOpenrouterKey } from "../agent"
import { trackTokenUsage } from "../lib/autumn-tracker"
import { applyTriageSeverity } from "../lib/issue-severity"
import { buildTriageContextMessage, TRIAGE_SYSTEM_PROMPT } from "./triage-prompt"
import { buildTriageToolSet, decodeTriageResult, SUBMIT_TRIAGE_TOOL_NAME } from "./triage-tools"
import type { WorkflowEventLike, WorkflowStepLike } from "./ClickHouseSchemaApplyWorkflow.run"

export interface AiTriageWorkflowEnv extends Record<string, unknown> {
	readonly MAPLE_DB: unknown
	readonly INTERNAL_SERVICE_TOKEN?: string
}

export interface AiTriageWorkflowPayload {
	readonly orgId: string
	readonly incidentKind: "error" | "anomaly" | "alert"
	readonly incidentId: string
	readonly issueId?: string
	readonly runId: string
}

export interface AiTriageWorkflowResult {
	readonly status: "completed" | "failed" | "skipped"
}

const decodeOrgId = Schema.decodeUnknownSync(OrgId)
const decodeRunId = Schema.decodeUnknownSync(AiTriageRunId)
const decodeIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const decodeEventId = Schema.decodeUnknownSync(ErrorIssueEventId)
const decodeAnomalyIncidentId = Schema.decodeUnknownSync(AnomalyIncidentId)

/** Lenient decode for the contextJson jsonb column; failures fall back to {}. */
const decodeContextJson = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
/**
 * One decode from the persisted resultJson string straight to AiTriageResult —
 * composing `fromJsonString` means a malformed string and a shape mismatch
 * both fail through the schema error channel instead of a bare JSON.parse
 * throw in front of the decode.
 */
const decodeTriageResultJson = Schema.decodeUnknownSync(Schema.fromJsonString(AiTriageResult))

/**
 * Typed wrapper for the LLM call's rejection so the Effect error channel is
 * not `unknown`. Unwrapped (`.cause`) at the squash-and-rethrow boundary so
 * the value thrown to the workflow runtime stays the original error.
 */
class TriageGenerateError extends Data.TaggedError("TriageGenerateError")<{
	readonly cause: unknown
}> {}

/**
 * UUIDv5-style id derived from the runId, so the timeline-event insert in the
 * retryable persist step is idempotent: a retry regenerates the SAME id and the
 * primary key (+ onConflictDoNothing) absorbs the duplicate.
 */
const deterministicEventId = (runId: string): string => {
	const hex = createHash("sha256").update(`ai-triage-event:${runId}`).digest("hex")
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`5${hex.slice(13, 16)}`,
		`${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
		hex.slice(20, 32),
	].join("-")
}

/**
 * Tracer for the triage LLM loop's `gen_ai.*` span. The workflow entrypoint
 * has no ambient tracer (the worker's telemetry layer lives in the HTTP
 * handler's runtime), so this module owns its own SDK instance and flushes it
 * explicitly after the agent step. Module scope is safe here — this file is
 * only ever dynamically imported inside `run()`, off the startup-CPU path.
 */
const triageTelemetry = MapleCloudflareSDK.make({
	serviceName: "maple-api",
	serviceNamespace: "backend",
	repositoryUrl: "https://github.com/Makisuo/maple",
})

const DEFAULT_TRIAGE_MODEL = "moonshotai/kimi-k2.7-code:nitro"
const MAX_AGENT_STEPS = 12
const MAX_OUTPUT_TOKENS = 4096

const GATE_STEP = { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } }
// One LLM retry at most — a retried step re-spends the whole agent loop.
const AGENT_STEP = {
	retries: { limit: 1, delay: "10 seconds" },
	timeout: "10 minutes",
}
const PERSIST_STEP = { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" } }

interface AgentStepResult {
	readonly resultJson: string
	readonly model: string
	readonly inputTokens: number
	readonly outputTokens: number
}

/**
 * Narrow the worker env's `MAPLE_DB` Hyperdrive binding to its connection
 * string. (Local copy of the schema-apply workflow's helper so this dynamic
 * chunk doesn't pull in the ClickHouse migration graph.)
 */
const resolveMapleDbConnectionString = (binding: unknown): string => {
	if (
		typeof binding === "object" &&
		binding !== null &&
		typeof (binding as { connectionString?: unknown }).connectionString === "string"
	) {
		return (binding as { connectionString: string }).connectionString
	}
	throw new Error("MAPLE_DB is not a Hyperdrive binding (missing connectionString)")
}

export interface AiTriageRunDeps {
	/** Test seam: swap the database client (e.g. a PGlite-backed drizzle) and model wiring. */
	readonly db?: MaplePgClient
	readonly generate?: typeof generateText
	readonly resolveApiKey?: typeof resolveOrgOpenrouterKey
	/**
	 * Test seam: skip `getMapleAgentSetup` (which dynamic-imports the whole app
	 * graph — too slow for the vitest budget on CI runners) and supply the
	 * ToolSet directly. Production always builds from the registry.
	 */
	readonly buildTools?: () => Promise<ToolSet>
	/** Test seam: fixed clock for timestamp assertions. Production uses Date.now. */
	readonly now?: () => number
}

export async function runAiTriage(
	env: AiTriageWorkflowEnv,
	event: WorkflowEventLike<AiTriageWorkflowPayload>,
	step: WorkflowStepLike,
	deps: AiTriageRunDeps = {},
): Promise<AiTriageWorkflowResult> {
	// Injected test clients are owned by the caller; the workflow only ends the
	// postgres.js connection it dialed itself.
	const connection: { readonly db: MaplePgClient; readonly end?: () => Promise<void> } =
		deps.db !== undefined
			? { db: deps.db }
			: createMaplePgClient(resolveMapleDbConnectionString(env.MAPLE_DB), { maxConnections: 1 })
	try {
		return await runAiTriageWithDb(connection.db, env, event, step, deps)
	} finally {
		await connection.end?.().catch(() => undefined)
	}
}

async function runAiTriageWithDb(
	db: MaplePgClient,
	env: AiTriageWorkflowEnv,
	event: WorkflowEventLike<AiTriageWorkflowPayload>,
	step: WorkflowStepLike,
	deps: AiTriageRunDeps,
): Promise<AiTriageWorkflowResult> {
	const { orgId, incidentKind, incidentId, issueId } = event.payload
	const runId = decodeRunId(event.payload.runId)
	const generate = deps.generate ?? generateText
	const resolveApiKey = deps.resolveApiKey ?? resolveOrgOpenrouterKey
	const clock = deps.now ?? Date.now

	/**
	 * Failure-path structured log, routed through the module's OTLP telemetry
	 * (console.error alone never reaches the log pipeline). Defensive: a
	 * telemetry problem must never mask the original failure path, so anything
	 * thrown here is caught and demoted to console.error.
	 */
	const logFailure = async (message: string, fields: Record<string, unknown>): Promise<void> => {
		try {
			await Effect.runPromise(
				Effect.logError(message, fields).pipe(Effect.provide(triageTelemetry.layer)),
			)
			await triageTelemetry.flush(env)
		} catch (cause) {
			console.error("ai-triage: failed to emit structured failure log", { error: String(cause) })
		}
	}

	const markFailed = async (error: string) => {
		const now = clock()
		try {
			await db
				.update(aiTriageRuns)
				.set({ status: "failed", error, completedAt: new Date(now), updatedAt: new Date(now) })
				.where(and(eq(aiTriageRuns.orgId, decodeOrgId(orgId)), eq(aiTriageRuns.id, runId)))
			if (incidentKind === "anomaly") {
				await db
					.update(anomalyIncidents)
					.set({ triageStatus: "skipped", updatedAt: new Date(now) })
					.where(
						and(
							eq(anomalyIncidents.orgId, decodeOrgId(orgId)),
							eq(anomalyIncidents.id, decodeAnomalyIncidentId(incidentId)),
						),
					)
			}
		} catch (cause) {
			// If this write is lost the row stays queued/running until the enqueue
			// path reclaims it as stranded (STALE_RUN_RECLAIM_MS) — surface why in
			// the Workers logs instead of swallowing it.
			console.error("ai-triage: failed to mark run failed", {
				runId,
				orgId,
				error: String(cause),
			})
			await logFailure("ai-triage: failed to mark run failed", {
				runId,
				orgId,
				error: String(cause),
			})
		}
	}

	const gate = await step.do("gate-and-claim", GATE_STEP, async () => {
		const rows = await db.select().from(aiTriageRuns).where(eq(aiTriageRuns.id, runId)).limit(1)
		const run = rows[0]
		// Replay guard: a re-delivered event for a run that already progressed is
		// a no-op (statuses other than queued mean another execution owns it).
		if (!run || run.status !== "queued") {
			return { proceed: false as const, contextJson: {}, modelOverride: null }
		}

		const key = await resolveApiKey(env, orgId)
		if (key === undefined) {
			return {
				proceed: false as const,
				failure: "no_openrouter_key",
				contextJson: run.contextJson,
				modelOverride: null,
			}
		}

		const settingsRows = await db
			.select()
			.from(aiTriageSettings)
			.where(eq(aiTriageSettings.orgId, run.orgId))
			.limit(1)

		const now = clock()
		await db
			.update(aiTriageRuns)
			.set({ status: "running", startedAt: new Date(now), updatedAt: new Date(now) })
			.where(eq(aiTriageRuns.id, runId))

		return {
			proceed: true as const,
			contextJson: run.contextJson,
			modelOverride: settingsRows[0]?.modelOverride ?? null,
		}
	})

	if (!gate.proceed) {
		if ("failure" in gate && gate.failure) {
			console.error("ai-triage: run failed before agent start", {
				runId,
				orgId,
				reason: gate.failure,
			})
			await logFailure("ai-triage: run failed before agent start", {
				runId,
				orgId,
				reason: gate.failure,
			})
			await markFailed(gate.failure)
			return { status: "failed" }
		}
		return { status: "skipped" }
	}

	let agentResult: AgentStepResult
	try {
		agentResult = await step.do("run-agent", AGENT_STEP, async () => {
			// The key is re-resolved inside the step (instead of returned from
			// gate-and-claim) so it never persists in durable workflow state.
			const apiKey = await resolveApiKey(env, orgId)
			if (apiKey === undefined) throw new Error("no_openrouter_key")

			const tools = deps.buildTools
				? await deps.buildTools()
				: buildTriageToolSet({
						setup: await getMapleAgentSetup(env),
						orgId,
						internalServiceToken: String(env.INTERNAL_SERVICE_TOKEN ?? ""),
					})

			const modelId = gate.modelOverride ?? DEFAULT_TRIAGE_MODEL
			const openrouter = createOpenAICompatible({
				name: "openrouter",
				baseURL: "https://openrouter.ai/api/v1",
				apiKey,
				headers: { "X-OpenRouter-Title": "Maple AI Triage" },
			})

			const context: Record<string, unknown> = Option.getOrElse(
				decodeContextJson(gate.contextJson),
				() => ({}),
			)

			// gen_ai.* semconv span around the LLM loop (no cost math — Maple's
			// central pricing layer derives cost from the token counts).
			const generateExit = await Effect.runPromiseExit(
				Effect.tryPromise({
					try: () =>
						generate({
							model: openrouter.chatModel(modelId),
							system: TRIAGE_SYSTEM_PROMPT,
							prompt: buildTriageContextMessage(incidentKind, context),
							tools,
							stopWhen: [hasToolCall(SUBMIT_TRIAGE_TOOL_NAME), stepCountIs(MAX_AGENT_STEPS)],
							maxOutputTokens: MAX_OUTPUT_TOKENS,
							providerOptions: {
								openrouter: {
									trace: {
										trace_id: runId,
										trace_name: "Maple AI Triage",
										generation_name: "Triage Investigation",
										orgId,
										operation: "auto_triage",
									},
								},
							},
						}),
					catch: (error) => new TriageGenerateError({ cause: error }),
				}).pipe(
					Effect.tap((r) =>
						Effect.annotateCurrentSpan({
							"gen_ai.usage.input_tokens": r.totalUsage.inputTokens ?? 0,
							"gen_ai.usage.output_tokens": r.totalUsage.outputTokens ?? 0,
						}),
					),
					Effect.withSpan("ai_triage.generate", {
						kind: "client",
						attributes: {
							"gen_ai.operation.name": "chat",
							"gen_ai.provider.name": "openrouter",
							"gen_ai.request.model": modelId,
							orgId,
						},
					}),
					Effect.provide(triageTelemetry.layer),
				),
			)
			await triageTelemetry.flush(env)
			// Re-throw the original error so the step's failure handling (and the
			// message persisted by markFailed) is unchanged by the span wrapper:
			// unwrap the TriageGenerateError envelope back to its cause; defects
			// (non-generate failures) are squashed and thrown as before.
			if (Exit.isFailure(generateExit)) {
				const squashed = Cause.squash(generateExit.cause)
				throw squashed instanceof TriageGenerateError ? squashed.cause : squashed
			}
			const result = generateExit.value

			const submitCall = result.steps
				.flatMap((s) => s.toolCalls ?? [])
				.find((call) => call.toolName === SUBMIT_TRIAGE_TOOL_NAME)
			if (!submitCall) {
				throw new Error("no_structured_result")
			}
			const decoded = decodeTriageResult(submitCall.input)

			return {
				resultJson: JSON.stringify(decoded),
				model: modelId,
				inputTokens: result.totalUsage.inputTokens ?? 0,
				outputTokens: result.totalUsage.outputTokens ?? 0,
			}
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error("ai-triage: agent run failed", { runId, orgId, error: message })
		await logFailure("ai-triage: agent run failed", { runId, orgId, error: message })
		await markFailed(message.slice(0, 2000))
		return { status: "failed" }
	}

	await step.do("persist", PERSIST_STEP, async () => {
		const now = clock()
		await db
			.update(aiTriageRuns)
			.set({
				status: "completed",
				// The agent step's durable output stays a JSON string (1 MiB step
				// cap bookkeeping); parse at the jsonb write boundary.
				resultJson: JSON.parse(agentResult.resultJson),
				model: agentResult.model,
				inputTokens: agentResult.inputTokens,
				outputTokens: agentResult.outputTokens,
				error: null,
				completedAt: new Date(now),
				updatedAt: new Date(now),
			})
			.where(and(eq(aiTriageRuns.orgId, decodeOrgId(orgId)), eq(aiTriageRuns.id, runId)))

		if (issueId) {
			// Any linked issue (error fingerprint, alert-backed, or anomaly-linked)
			// gets the triage outcome applied: severity (respecting manual
			// override) + timeline events + escalation outbox. All writes are
			// idempotent via runId-derived deterministic ids, so a retried persist
			// step cannot duplicate them.
			const result = decodeTriageResultJson(agentResult.resultJson)
			const applied = await applyTriageSeverity(db, {
				orgId: decodeOrgId(orgId),
				issueId: decodeIssueId(issueId),
				runId,
				severity: result.severityAssessment,
				confidence: result.confidence,
				timestamp: now,
				result,
			})
			await db
				.insert(errorIssueEvents)
				.values({
					id: decodeEventId(deterministicEventId(runId)),
					orgId: decodeOrgId(orgId),
					issueId: decodeIssueId(issueId),
					actorId: applied.actorId,
					type: "ai_triage",
					payloadJson: {
						runId,
						summary: result.summary,
						severityAssessment: result.severityAssessment,
						confidence: result.confidence,
						applied: applied.applied,
					},
					createdAt: new Date(now),
				})
				.onConflictDoNothing()
		}

		if (incidentKind === "anomaly") {
			await db
				.update(anomalyIncidents)
				.set({ triageStatus: "completed", updatedAt: new Date(now) })
				.where(
					and(
						eq(anomalyIncidents.orgId, decodeOrgId(orgId)),
						eq(anomalyIncidents.id, decodeAnomalyIncidentId(incidentId)),
					),
				)
		}

		await trackTokenUsage(env, {
			orgId,
			inputTokens: agentResult.inputTokens,
			outputTokens: agentResult.outputTokens,
			idempotencyKey: runId,
			source: "triage",
		})
	})

	return { status: "completed" }
}
