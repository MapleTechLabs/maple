/**
 * Identifiers and states of the scheduled security audit: a target (one repository branch the org
 * audits), its runs, and the findings followed across runs.
 */
import { Schema } from "effect"

export { executionModeLine, type ExecutionProfile } from "@maple/security-audit/ecosystems"

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

export const SecurityAuditProfile = Schema.Literals(["quick", "standard", "deep"])
export type SecurityAuditProfile = typeof SecurityAuditProfile.Type

export const SecurityAuditRunKind = Schema.Literals(["baseline", "slice", "revalidation", "manual"])
export type SecurityAuditRunKind = typeof SecurityAuditRunKind.Type

export const SecurityAuditRunStatus = Schema.Literals(["in_progress", "complete", "incomplete", "failed"])
export type SecurityAuditRunStatus = typeof SecurityAuditRunStatus.Type

export const SecurityAuditVerdict = Schema.Literals(["confirmed", "needs_validation", "rejected"])
export type SecurityAuditVerdict = typeof SecurityAuditVerdict.Type

export const SecurityAuditSeverity = Schema.Literals(["informational", "low", "medium", "high", "critical"])
export type SecurityAuditSeverity = typeof SecurityAuditSeverity.Type

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
	{ id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "OpenAI", eu: true, verifies: false },
	{ id: "openai/gpt-6-luna", label: "GPT-6 Luna", provider: "OpenAI", eu: true, verifies: true },
] as const

export type SecurityAuditModelOption = (typeof SECURITY_AUDIT_MODELS)[number]

/** A model that hunts: any in the catalogue. */
export const SecurityAuditDiscoveryModel = Schema.Literals(SECURITY_AUDIT_MODELS.map((model) => model.id))
export type SecurityAuditDiscoveryModel = typeof SecurityAuditDiscoveryModel.Type

/** A model that verifies: one that answered verifier prompts in the eval. */
export const SecurityAuditValidationModel = Schema.Literals(
	SECURITY_AUDIT_MODELS.filter((model) => model.verifies).map((model) => model.id),
)
export type SecurityAuditValidationModel = typeof SecurityAuditValidationModel.Type

/** The catalogue entry for an id, or undefined for one the catalogue no longer lists. */
export const securityAuditModelOption = (id: string): SecurityAuditModelOption | undefined =>
	SECURITY_AUDIT_MODELS.find((model) => model.id === id)

const PATH_FORBIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u
const WINDOWS_RESERVED_COMPONENT =
	/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu

/**
 * A repository-relative path the engine accepts as a scope path. Mirrors `isSafeRelativePath` in
 * `@maple/security-audit`, which domain cannot import (it pulls in `node:path`).
 */
export const isSafeScopePath = (value: string): boolean =>
	value.length > 0 &&
	value.trim() === value &&
	!PATH_FORBIDDEN_CHARACTER.test(value) &&
	!value.includes("\\") &&
	!value.includes(":") &&
	!value.startsWith("/") &&
	!value.startsWith("~") &&
	value
		.split("/")
		.every(
			(segment) =>
				segment !== "" &&
				segment !== "." &&
				segment !== ".." &&
				!/[ .]$/u.test(segment) &&
				!WINDOWS_RESERVED_COMPONENT.test(segment),
		)
