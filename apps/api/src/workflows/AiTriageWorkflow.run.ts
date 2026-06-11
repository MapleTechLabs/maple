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
import { randomUUID } from "node:crypto"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText, hasToolCall, stepCountIs } from "ai"
import { aiTriageRuns, aiTriageSettings, anomalyIncidents, errorIssueEvents } from "@maple/db"
import { createMapleD1Client, type CloudflareD1Database, type MapleD1Client } from "@maple/db/client"
import {
	AiTriageRunId,
	AnomalyIncidentId,
	ErrorIssueEventId,
	ErrorIssueId,
	OrgId,
} from "@maple/domain/primitives"
import { and, eq } from "drizzle-orm"
import { Schema } from "effect"
import { getMapleAgentSetup, resolveOrgOpenrouterKey } from "../agent"
import { trackTokenUsage } from "../lib/autumn-tracker"
import { buildTriageContextMessage, TRIAGE_SYSTEM_PROMPT } from "./triage-prompt"
import { buildTriageToolSet, decodeTriageResult, SUBMIT_TRIAGE_TOOL_NAME } from "./triage-tools"
import type { WorkflowEventLike, WorkflowStepLike } from "./ClickHouseSchemaApplyWorkflow.run"

export interface AiTriageWorkflowEnv extends Record<string, unknown> {
	readonly MAPLE_DB: unknown
	readonly INTERNAL_SERVICE_TOKEN?: string
}

export interface AiTriageWorkflowPayload {
	readonly orgId: string
	readonly incidentKind: "error" | "anomaly"
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

const DEFAULT_TRIAGE_MODEL = "moonshotai/kimi-k2.5:nitro"
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

export interface AiTriageRunDeps {
	/** Test seam: swap the D1 client (e.g. a libsql-backed drizzle) and model wiring. */
	readonly db?: MapleD1Client
	readonly generate?: typeof generateText
	readonly resolveApiKey?: typeof resolveOrgOpenrouterKey
}

export async function runAiTriage(
	env: AiTriageWorkflowEnv,
	event: WorkflowEventLike<AiTriageWorkflowPayload>,
	step: WorkflowStepLike,
	deps: AiTriageRunDeps = {},
): Promise<AiTriageWorkflowResult> {
	const { orgId, incidentKind, incidentId, issueId } = event.payload
	const runId = decodeRunId(event.payload.runId)
	const db = deps.db ?? createMapleD1Client(env.MAPLE_DB as CloudflareD1Database)
	const generate = deps.generate ?? generateText
	const resolveApiKey = deps.resolveApiKey ?? resolveOrgOpenrouterKey

	const markFailed = async (error: string) => {
		const now = Date.now()
		await db
			.update(aiTriageRuns)
			.set({ status: "failed", error, completedAt: now, updatedAt: now })
			.where(eq(aiTriageRuns.id, runId))
			.catch(() => undefined)
		if (incidentKind === "anomaly") {
			await db
				.update(anomalyIncidents)
				.set({ triageStatus: "skipped", updatedAt: now })
				.where(eq(anomalyIncidents.id, decodeAnomalyIncidentId(incidentId)))
				.catch(() => undefined)
		}
	}

	const gate = await step.do("gate-and-claim", GATE_STEP, async () => {
		const rows = await db.select().from(aiTriageRuns).where(eq(aiTriageRuns.id, runId)).limit(1)
		const run = rows[0]
		// Replay guard: a re-delivered event for a run that already progressed is
		// a no-op (statuses other than queued mean another execution owns it).
		if (!run || run.status !== "queued") {
			return { proceed: false as const, contextJson: "{}", modelOverride: null }
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

		const now = Date.now()
		await db
			.update(aiTriageRuns)
			.set({ status: "running", startedAt: now, updatedAt: now })
			.where(eq(aiTriageRuns.id, runId))

		return {
			proceed: true as const,
			contextJson: run.contextJson,
			modelOverride: settingsRows[0]?.modelOverride ?? null,
		}
	})

	if (!gate.proceed) {
		if ("failure" in gate && gate.failure) {
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

			const setup = await getMapleAgentSetup(env)
			const tools = buildTriageToolSet({
				setup,
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

			let context: Record<string, unknown>
			try {
				context = JSON.parse(gate.contextJson) as Record<string, unknown>
			} catch {
				context = {}
			}

			const result = await generate({
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
			})

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
		await markFailed(message.slice(0, 2000))
		return { status: "failed" }
	}

	await step.do("persist", PERSIST_STEP, async () => {
		const now = Date.now()
		await db
			.update(aiTriageRuns)
			.set({
				status: "completed",
				resultJson: agentResult.resultJson,
				model: agentResult.model,
				inputTokens: agentResult.inputTokens,
				outputTokens: agentResult.outputTokens,
				error: null,
				completedAt: now,
				updatedAt: now,
			})
			.where(eq(aiTriageRuns.id, runId))

		if (incidentKind === "error" && issueId) {
			// Surfaces the triage on the existing issue timeline UI. actorId stays
			// null — the run row itself is the authoritative record.
			const result = JSON.parse(agentResult.resultJson) as {
				summary?: string
				severityAssessment?: string
				confidence?: string
			}
			await db.insert(errorIssueEvents).values({
				id: decodeEventId(randomUUID()),
				orgId: decodeOrgId(orgId),
				issueId: decodeIssueId(issueId),
				actorId: null,
				type: "ai_triage",
				payloadJson: JSON.stringify({
					runId,
					summary: result.summary,
					severityAssessment: result.severityAssessment,
					confidence: result.confidence,
				}),
				createdAt: now,
			})
		}

		if (incidentKind === "anomaly") {
			await db
				.update(anomalyIncidents)
				.set({ triageStatus: "completed", updatedAt: now })
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
