/**
 * What the audit engine needs from its host. The engine is the skill's parent: deterministic code
 * that owns shared state and decides every transition from agent results. Hosts supply agents (a
 * local runner, or a Workflow that makes each invocation a durable step) and a store that
 * persists each result as it arrives.
 */
import { Context, type Effect, Schema } from "effect"
import type { ExecutionPolicy } from "../prompts"
import type { CoverageUnit, Finding } from "../schema"

export const AuditRole = Schema.Literals([
	"recon",
	"synthesis",
	"hunter",
	"critic",
	"candidate-verifier",
	"record-verifier",
])
export type AuditRole = typeof AuditRole.Type

export interface AgentInvocation {
	readonly role: AuditRole
	/** Canonical, unique within the run, and stable across a replay of the same run. */
	readonly agentId: string
	readonly prompt: string
}

export interface AgentUsage {
	readonly inputTokens: number
	readonly outputTokens: number
	readonly costUsd?: number
}

export interface AgentAnswer {
	readonly text: string
	readonly usage?: AgentUsage
	/** Tool calls the agent made; absent from answers recorded before it was counted. */
	readonly toolCalls?: number
}

export class AuditAgentError extends Schema.TaggedError<AuditAgentError>()(
	"@maple/security-audit/AgentError",
	{
		message: Schema.String,
		role: AuditRole,
		agentId: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/**
 * The host refused to launch an agent because the org's invocation budget is spent. The engine
 * launches nothing more and ends the run incomplete with `reason`.
 */
export class AuditBudgetExhaustedError extends Schema.TaggedError<AuditBudgetExhaustedError>()(
	"@maple/security-audit/BudgetExhaustedError",
	{ message: Schema.String, agentId: Schema.String, reason: Schema.String },
) {}

export interface AuditAgentsApi {
	/**
	 * Runs one fresh agent and returns its final text. Each call is a new agent with no memory of
	 * another; the role picks its model and tools (discovery and validation use different models).
	 */
	readonly run: (
		invocation: AgentInvocation,
	) => Effect.Effect<AgentAnswer, AuditAgentError | AuditBudgetExhaustedError>
}

export class AuditAgents extends Context.Service<AuditAgents, AuditAgentsApi>()(
	"@maple/security-audit/AuditAgents",
) {}

export type RunStatus = "in_progress" | "complete" | "incomplete"

/** The skill's `run-metadata.json`. */
export interface RunMetadata {
	readonly run_id: string
	readonly repo: string
	readonly target: string
	readonly source_ref: string
	readonly profile: "quick" | "standard" | "deep"
	readonly scope_paths: ReadonlyArray<string>
	readonly budget: number | null
	readonly execution_policy: "sandboxed-source-and-local-only"
	readonly execution: ExecutionPolicy
	readonly prior_runs: ReadonlyArray<string>
	readonly run_status: RunStatus
	readonly incomplete_reason?: string
}

export type AuditEvent =
	| {
			readonly _tag: "Agent"
			readonly role: AuditRole
			readonly agentId: string
			/** `discarded`: the answer broke its contract and was dropped unrepaired, per the skill. */
			readonly outcome: "ok" | "discarded" | "failed"
			readonly message?: string
			readonly usage?: AgentUsage
	  }
	| { readonly _tag: "Phase"; readonly phase: string; readonly detail: string }
	| { readonly _tag: "Note"; readonly message: string }

export interface AuditReports {
	readonly report: string
	readonly findingsDetail: string
	readonly needsValidation: string
}

export class AuditStoreError extends Schema.TaggedError<AuditStoreError>()(
	"@maple/security-audit/StoreError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/**
 * The parent's shared files, persisted as they change. Every write is a full replacement keyed by
 * the run, so a replayed step writing the same value again is harmless.
 */
export interface AuditStoreApi {
	readonly saveMetadata: (metadata: RunMetadata) => Effect.Effect<void, AuditStoreError>
	readonly saveArchitecture: (runId: string, architectureMd: string) => Effect.Effect<void, AuditStoreError>
	readonly saveLedger: (
		runId: string,
		ledger: ReadonlyArray<CoverageUnit>,
	) => Effect.Effect<void, AuditStoreError>
	readonly saveFindings: (
		runId: string,
		findings: ReadonlyArray<Finding>,
	) => Effect.Effect<void, AuditStoreError>
	readonly saveReports: (runId: string, reports: AuditReports) => Effect.Effect<void, AuditStoreError>
	readonly recordEvent: (runId: string, event: AuditEvent) => Effect.Effect<void, AuditStoreError>
}

export class AuditStore extends Context.Service<AuditStore, AuditStoreApi>()(
	"@maple/security-audit/AuditStore",
) {}
