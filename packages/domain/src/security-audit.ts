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
 * that refused verifier prompts in the phase 0 eval.
 */
export const SECURITY_AUDIT_MODELS = [
	{
		id: "deepseek/deepseek-v4.1-flash-1017:nitro",
		label: "DeepSeek V4.1 Flash",
		provider: "DeepSeek",
		eu: false,
		verifies: true,
	},
	{
		id: "anthropic/claude-sonnet-5.5",
		label: "Claude Sonnet 5.5",
		provider: "Anthropic",
		eu: true,
		verifies: true,
	},
	{
		id: "anthropic/claude-haiku-5.5",
		label: "Claude Haiku 5.5",
		provider: "Anthropic",
		eu: true,
		verifies: true,
	},
	{ id: "openai/gpt-6-luna", label: "GPT-6 Luna", provider: "OpenAI", eu: true, verifies: true },
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

/** The catalogue entry for an id, or undefined for one the catalogue no longer lists. */
export const securityAuditModelOption = (id: string): SecurityAuditModelOption | undefined =>
	Option.getOrUndefined(Arr.findFirst(SECURITY_AUDIT_MODELS, (model) => model.id === id))
