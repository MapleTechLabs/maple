/**
 * Identifiers and states of the scheduled security audit: a target (one repository branch the org
 * audits), its runs, and the findings followed across runs.
 */
import { Option, Schema, Array as Arr } from "effect"

export { executionModeLine, type ExecutionProfile } from "@maple/security-audit/ecosystems"
import {
	Profile as SecurityAuditProfile,
	Severity as SecurityAuditSeverity,
	Verdict as SecurityAuditVerdict,
} from "@maple/security-audit/schema"

export { SecurityAuditProfile, SecurityAuditSeverity, SecurityAuditVerdict }
export { isSafeScopePath } from "@maple/security-audit/scope-path"

export const SecurityAuditTargetId = Schema.String.check(Schema.isUUID()).pipe(
	Schema.brand("@maple/SecurityAuditTargetId"),
	Schema.annotate({ identifier: "@maple/SecurityAuditTargetId", title: "Security Audit Target ID" }),
)
export type SecurityAuditTargetId = Schema.Schema.Type<typeof SecurityAuditTargetId>

/** The engine's `run_id`; the host mints it, so it is any non-empty string. */
export const SecurityAuditRunId = Schema.String.check(Schema.isNonEmpty()).pipe(
	Schema.brand("@maple/SecurityAuditRunId"),
	Schema.annotate({ identifier: "@maple/SecurityAuditRunId", title: "Security Audit Run ID" }),
)
export type SecurityAuditRunId = Schema.Schema.Type<typeof SecurityAuditRunId>

export const SecurityAuditRunKind = Schema.Literals(["baseline", "slice", "revalidation", "manual"])
export type SecurityAuditRunKind = typeof SecurityAuditRunKind.Type

export const SecurityAuditRunStatus = Schema.Literals(["in_progress", "complete", "incomplete", "failed"])
export type SecurityAuditRunStatus = typeof SecurityAuditRunStatus.Type

/** A finding's lifecycle on its target; only `fixed` reopens when the fingerprint comes back. */
export const SecurityAuditFindingStatus = Schema.Literals(["open", "fixed", "dismissed", "accepted_risk"])
export type SecurityAuditFindingStatus = typeof SecurityAuditFindingStatus.Type

export const SecurityAuditEventKind = Schema.Literals(["Agent", "Phase", "Note"])
export type SecurityAuditEventKind = typeof SecurityAuditEventKind.Type

/** What starts one audit run in the ai Worker's Workflow. The run row exists before it starts. */
export const SecurityAuditWorkflowPayload = Schema.Struct({
	orgId: Schema.String,
	runId: Schema.String,
	repository: Schema.String,
	/** Branch or commit; the run pins the commit it resolves to before any agent starts. */
	ref: Schema.String,
	profile: SecurityAuditProfile,
	scopePaths: Schema.Array(Schema.String),
	/** Max agent invocations; null leaves the run unbounded, so the org's monthly spend limit stops it. */
	budget: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
	/** OpenRouter model ids, resolved at start so a replay runs on the same models. */
	models: Schema.Struct({ discovery: Schema.String, validation: Schema.String }),
	priorRunId: Schema.NullOr(Schema.String),
})
export type SecurityAuditWorkflowPayload = typeof SecurityAuditWorkflowPayload.Type

/** Why a run ends incomplete when the org's AI credits run out mid-run. */
export const ORG_NO_AI_CREDITS = "org_no_ai_credits"

/** Why a run ends incomplete when the org reaches its monthly spend limit mid-run. */
export const ORG_SPEND_LIMIT_REACHED = "org_spend_limit_reached"

/** Why a run ends incomplete when the org's audit spend could not be read (billing unreachable). */
export const ORG_BUDGET_UNAVAILABLE = "org_budget_unavailable"

/** The UTC month containing `epochMs`: when an org's audit spend started counting, and when it resets. */
export const securityAuditSpendWindow = (
	epochMs: number,
): { readonly since: number; readonly resetsAt: number } => {
	const now = new Date(epochMs)
	return {
		since: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
		resetsAt: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
	}
}

/**
 * The models an org may pick for its audits, as OpenRouter ids. `eu` marks a model the EU instance
 * serves; there, a pick without it runs on the region's default. `verifies` is false for a model
 * that refused verifier prompts in the phase 0 eval. `inputUsd` and `outputUsd` are OpenRouter's
 * list prices per million tokens; `intelligenceIndex` is the public benchmark score named by
 * `SECURITY_AUDIT_INTELLIGENCE_SOURCE` (both checked 2026-11-12).
 */
export const SECURITY_AUDIT_MODELS = [
	{
		id: "deepseek/deepseek-v4.1-flash-1017:nitro",
		label: "DeepSeek V4.1 Flash",
		provider: "DeepSeek",
		eu: false,
		verifies: true,
		inputUsd: 0.15,
		outputUsd: 0.6,
		intelligenceIndex: 29,
	},
	{
		id: "anthropic/claude-sonnet-5.5",
		label: "Claude Sonnet 5.5",
		provider: "Anthropic",
		eu: true,
		verifies: true,
		inputUsd: 2,
		outputUsd: 10,
		intelligenceIndex: 42,
	},
	{
		id: "anthropic/claude-haiku-5.5",
		label: "Claude Haiku 5.5",
		provider: "Anthropic",
		eu: true,
		verifies: true,
		inputUsd: 0.1,
		outputUsd: 0.5,
		intelligenceIndex: 30,
	},
	{
		id: "openai/gpt-6-luna",
		label: "GPT-6 Luna",
		provider: "OpenAI",
		eu: true,
		verifies: true,
		inputUsd: 0.1,
		outputUsd: 0.5,
		intelligenceIndex: 21,
	},
] as const

export type SecurityAuditModelOption = (typeof SECURITY_AUDIT_MODELS)[number]

/** A model that hunts: any in the catalogue. */
export const SecurityAuditDiscoveryModel = Schema.Literals(
	Arr.map(SECURITY_AUDIT_MODELS, (model) => model.id),
)
export type SecurityAuditDiscoveryModel = typeof SecurityAuditDiscoveryModel.Type

/** A model that verifies: one that answered verifier prompts in the eval. */
export const SecurityAuditValidationModel = Schema.Literals(
	Arr.map(
		Arr.filter(SECURITY_AUDIT_MODELS, (model) => model.verifies),
		(model) => model.id,
	),
)
export type SecurityAuditValidationModel = typeof SecurityAuditValidationModel.Type

/** Upper bounds of levels 1 to 4 on a five-level rating; anything above the last is level 5. */
type LevelBounds = readonly [number, number, number, number]

/** How many levels a price or intelligence rating has: one per bound, plus the open-ended top. */
export const SECURITY_AUDIT_RATING_LEVELS = 5

const levelWithin = (bounds: LevelBounds, value: number): number =>
	Option.getOrElse(
		Arr.findFirstIndex(bounds, (bound) => value <= bound),
		() => bounds.length,
	) + 1

/** Audit agents read far more than they write (about 4.6M input tokens a run), so input weighs 3 to 1. */
type ListPrice = Readonly<{ inputUsd: number; outputUsd: number }>

/** Blended dollars per million tokens; each step is roughly 3x the last. */
const PRICE_LEVEL_BOUNDS: LevelBounds = [0.5, 1.5, 5, 15]

/** A model's list price as a level from 1 (cheapest) to 5. */
export const securityAuditPriceLevel = (model: ListPrice): number =>
	levelWithin(PRICE_LEVEL_BOUNDS, (3 * model.inputUsd + model.outputUsd) / 4)

/** Where `intelligenceIndex` comes from, as the picker's tooltip names it. */
export const SECURITY_AUDIT_INTELLIGENCE_SOURCE = "Artificial Analysis Intelligence Index v5.0.1, high effort"

/** Index points, 10 per level; the leaderboard tops out in the 60s. */
const INTELLIGENCE_LEVEL_BOUNDS: LevelBounds = [15, 25, 35, 45]

/** A model's public benchmark score as a level from 1 to 5. */
export const securityAuditIntelligenceLevel = (model: Readonly<{ intelligenceIndex: number }>): number =>
	levelWithin(INTELLIGENCE_LEVEL_BOUNDS, model.intelligenceIndex)

/** The catalogue entry for an id, or undefined for one the catalogue no longer lists. */
export const securityAuditModelOption = (id: string): SecurityAuditModelOption | undefined =>
	Option.getOrUndefined(Arr.findFirst(SECURITY_AUDIT_MODELS, (model) => model.id === id))
