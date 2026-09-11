// BOUNDARY: Private RPC data and opaque tool payloads are decoded by the receiving service.
import type { LensVerdict } from "./http"
import { Schema } from "effect"
import type { Effect } from "effect"
import { ChatTurnTenant, ChatMessage } from "./chat-session"
import type { InternalMcpToolResult } from "./internal-rpc"
import { InvestigationId, OrgId } from "./primitives"

export type InvokePlannerInput = typeof InvokePlannerInput.Encoded

export interface InvokePlannerOutput {
	/** Null when the planner never submitted; `normalizePlan` falls back to seeds. */
	readonly plan: unknown | null
	readonly model: string
	readonly inputTokens: number
	readonly outputTokens: number
	readonly toolCount: number
}

export type InvokeHypothesisInput = typeof InvokeHypothesisInput.Encoded

export interface InvokeHypothesisOutput {
	/** Null when the lane reached no candidate. */
	readonly claim: string | null
	readonly mechanism: string | null
	readonly confidence: "high" | "medium" | "low" | null
	readonly selfDoubt: string | null
	readonly suggestedActions: ReadonlyArray<string>
	readonly evidence: ReadonlyArray<unknown>
	/** Set only on the collapsed path: the report to publish directly. */
	readonly report: unknown | null
	readonly model: string
	readonly inputTokens: number
	readonly outputTokens: number
	readonly toolCount: number
	/**
	 * True when the lane answered because its wall clock ran out, not because it
	 * was done. Carried to the row and into the validator's view of the candidate:
	 * "checked and found nothing" and "ran out of clock" are different reports, and
	 * ranking them the same is how a cut-short lane gets counted as a clean
	 * negative that rules out a rival.
	 */
	readonly deadlineHit: boolean
}

export type InvokeValidatorInput = typeof InvokeValidatorInput.Encoded

export interface InvokeValidatorOutput {
	readonly promotedLensId: string | null
	readonly report: unknown | null
	readonly rivals: ReadonlyArray<{ lensId: string; verdict: LensVerdict; reason: string }>
	readonly note: string
	readonly model: string
	readonly inputTokens: number
	readonly outputTokens: number
}

export const AiToolDescriptor = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	inputSchema: Schema.Record(Schema.String, Schema.Unknown),
	mutating: Schema.Boolean,
})
export type AiToolDescriptor = typeof AiToolDescriptor.Type
const TokenCount = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export const AiRunUsage = Schema.Struct({ input: TokenCount, output: TokenCount, cacheRead: TokenCount })
export interface RunUsage {
	input: number
	output: number
	cacheRead: number
}
export const makeRunUsage = (): RunUsage => ({ input: 0, output: 0, cacheRead: 0 })

/** Capabilities are scoped by the caller to one authenticated run; no tenant is accepted by callbacks. */
export interface AiToolCallbacks {
	readonly execute: (name: string, input: unknown) => Promise<InternalMcpToolResult>
}
export interface AiChatCallbacks extends AiToolCallbacks {
	readonly publish: (events: ReadonlyArray<string>, usage: RunUsage) => Promise<boolean>
	readonly submitDiagnosis: (request: unknown) => Promise<void>
}
export const AiChatInput = Schema.Struct({
	sessionId: Schema.String,
	messageId: Schema.String,
	tenant: ChatTurnTenant,
	tools: Schema.Array(AiToolDescriptor),
	text: Schema.String,
	history: Schema.Array(ChatMessage),
	compaction: Schema.optionalKey(Schema.Struct({ summary: Schema.String, throughSeq: Schema.Finite })),
})
export type AiChatInput = typeof AiChatInput.Encoded

export class AiServiceError extends Schema.TaggedError<AiServiceError>()("@maple/ai/ServiceError", {
	message: Schema.String,
}) {}

/** Private service-binding RPC. The API owns durable state; the AI service owns execution. */
export interface AiServiceRpc {
	readonly chat: (input: AiChatInput, callbacks: AiChatCallbacks) => Effect.Effect<void, AiServiceError>
	readonly plan: (
		input: InvokePlannerInput,
		tools: ReadonlyArray<AiToolDescriptor>,
		callbacks: AiToolCallbacks,
	) => Effect.Effect<InvokePlannerOutput, AiServiceError>
	readonly hypothesis: (
		input: InvokeHypothesisInput,
		tools: ReadonlyArray<AiToolDescriptor>,
		callbacks: AiToolCallbacks,
	) => Effect.Effect<InvokeHypothesisOutput, AiServiceError>
	readonly validate: (
		input: InvokeValidatorInput,
		tools: ReadonlyArray<AiToolDescriptor>,
		callbacks: AiToolCallbacks,
	) => Effect.Effect<InvokeValidatorOutput, AiServiceError>
}

const passFields = {
	orgId: OrgId,
	investigationId: InvestigationId,
	subject: Schema.Unknown,
	snapshot: Schema.Unknown,
	deadlineAtMs: Schema.Finite,
}
export const InvokePlannerInput = Schema.Struct(passFields)
export const InvokeHypothesisInput = Schema.Struct({
	...passFields,
	hypothesis: Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		question: Schema.String,
		claimToTest: Schema.String,
		rationale: Schema.String,
		toolNames: Schema.Array(Schema.String),
		priority: Schema.Finite,
		seedLensId: Schema.NullOr(Schema.String),
	}),
	scopeSummary: Schema.String,
	solo: Schema.Boolean,
	rerun: Schema.Boolean,
})
export const InvokeValidatorInput = Schema.Struct({
	...passFields,
	candidates: Schema.Array(
		Schema.Struct({
			lensId: Schema.String,
			name: Schema.NullOr(Schema.String),
			claim: Schema.NullOr(Schema.String),
			mechanism: Schema.NullOr(Schema.String),
			confidence: Schema.NullOr(Schema.String),
			selfDoubt: Schema.NullOr(Schema.String),
			suggestedActions: Schema.Array(Schema.String),
			evidence: Schema.Array(Schema.Unknown),
			note: Schema.NullOr(Schema.String),
			deadlineHit: Schema.Boolean,
		}),
	),
})
