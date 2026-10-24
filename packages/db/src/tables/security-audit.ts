import * as PG from "@maple-dev/effect-orm/postgres"
import { VcsRepositoryId } from "@maple/domain/http/vcs"
import { OrgId, UserId } from "@maple/domain/primitives"
import {
	SecurityAuditEventKind,
	SecurityAuditFindingStatus,
	SecurityAuditProfile,
	SecurityAuditRunId,
	SecurityAuditRunKind,
	SecurityAuditRunStatus,
	SecurityAuditSeverity,
	SecurityAuditTargetId,
	SecurityAuditVerdict,
} from "@maple/domain/security-audit"
import {
	AuditReportsRecord,
	CoverageUnit,
	Finding,
	RunMetadataRecord,
	UnitStatus,
} from "@maple/security-audit/schema"
import { ExecutionProfile } from "@maple/security-audit/ecosystems"
import { Schema } from "effect"

// Scheduled security audits. A target is one repository branch an org audits; each run writes
// its ledger, findings and events keyed by run, and findings are also followed per target.
// No FKs (house style): the store service enforces the links and always filters by org.

const ScopePaths = Schema.Array(Schema.String)

/** One repository branch an org audits, with its cadence and the models it overrides. */
export const SecurityAuditTargets = PG.table("security_audit_targets", {
	columns: {
		id: PG.brand(PG.text, SecurityAuditTargetId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** `owner/name`. */
		repository: PG.text,
		/** The connected `vcs_repositories` row, when the repository came from a VCS integration. */
		vcsRepositoryId: PG.column(PG.nullable(PG.brand(PG.text, VcsRepositoryId)), {
			name: "vcs_repository_id",
		}),
		branch: PG.text,
		enabled: PG.column(PG.bool, { default: true }),
		profile: PG.column(PG.brand(PG.text, SecurityAuditProfile), { default: "deep" }),
		scopePaths: PG.column(PG.jsonb(ScopePaths), { name: "scope_paths" }),
		sliceIntervalHours: PG.column(PG.nullable(PG.int4), { name: "slice_interval_hours" }),
		revalidateOnPush: PG.column(PG.bool, { name: "revalidate_on_push", default: false }),
		/** Max agent invocations per run; null is unbounded. */
		budgetPerRun: PG.column(PG.nullable(PG.int4), { name: "budget_per_run" }),
		monthlyInvocationBudget: PG.column(PG.nullable(PG.int4), { name: "monthly_invocation_budget" }),
		/** OpenRouter model ids overriding the org's; null runs on the org's pick. */
		discoveryModel: PG.column(PG.nullable(PG.text), { name: "discovery_model" }),
		validationModel: PG.column(PG.nullable(PG.text), { name: "validation_model" }),
		createdBy: PG.column(PG.brand(PG.text, UserId), { name: "created_by" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("security_audit_targets_org_created_idx", ["orgId", "createdAt"]),
		PG.uniqueIndex("security_audit_targets_org_repo_branch_idx", ["orgId", "repository", "branch"]),
	],
	tenantColumn: "orgId",
})

/** One engine run over a target at one ref. `id` is the engine's `run_id`. */
export const SecurityAuditRuns = PG.table("security_audit_runs", {
	columns: {
		id: PG.brand(PG.text, SecurityAuditRunId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		targetId: PG.column(PG.brand(PG.text, SecurityAuditTargetId), { name: "target_id" }),
		kind: PG.brand(PG.text, SecurityAuditRunKind),
		sourceRef: PG.column(PG.text, { name: "source_ref" }),
		profile: PG.brand(PG.text, SecurityAuditProfile),
		scopePaths: PG.column(PG.jsonb(ScopePaths), { name: "scope_paths" }),
		/** Max agent invocations for this run; null is unbounded. */
		budget: PG.nullable(PG.int4),
		/** The engine's `run-metadata.json`; null until the engine first saves it. */
		metadata: PG.nullable(PG.jsonb(RunMetadataRecord)),
		status: PG.column(PG.brand(PG.text, SecurityAuditRunStatus), { default: "in_progress" }),
		incompleteReason: PG.column(PG.nullable(PG.text), { name: "incomplete_reason" }),
		architectureMd: PG.column(PG.nullable(PG.text), { name: "architecture_md" }),
		reports: PG.nullable(PG.jsonb(AuditReportsRecord)),
		/** How the run may execute target code and why not; null until prepare inspects the repository. */
		executionProfile: PG.column(PG.nullable(PG.jsonb(ExecutionProfile)), { name: "execution_profile" }),
		invocationsSpent: PG.column(PG.int4, { name: "invocations_spent", default: 0 }),
		inputTokens: PG.column(PG.int8, { name: "input_tokens", default: 0 }),
		outputTokens: PG.column(PG.int8, { name: "output_tokens", default: 0 }),
		costUsd: PG.column(PG.nullable(PG.float8), { name: "cost_usd" }),
		/** The OpenRouter model ids the run used; null for runs from before they were recorded. */
		discoveryModel: PG.column(PG.nullable(PG.text), { name: "discovery_model" }),
		validationModel: PG.column(PG.nullable(PG.text), { name: "validation_model" }),
		workflowInstanceId: PG.column(PG.nullable(PG.text), { name: "workflow_instance_id" }),
		startedAt: PG.column(PG.timestamptzMillis, { name: "started_at" }),
		finishedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "finished_at" }),
		error: PG.nullable(PG.text),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("security_audit_runs_org_started_idx", ["orgId", "startedAt"]),
		PG.index("security_audit_runs_target_started_idx", ["targetId", "startedAt"]),
		// One unfinished run per target; the store refuses a second before the insert reaches this.
		PG.uniqueIndex("security_audit_runs_one_running_idx", ["targetId"], {
			where: ($) => $.finishedAt.isNull(),
		}),
	],
	tenantColumn: "orgId",
})

/** The run's coverage ledger, one row per unit; replaced whole on every save. */
export const SecurityAuditUnits = PG.table("security_audit_units", {
	columns: {
		runId: PG.column(PG.brand(PG.text, SecurityAuditRunId), { name: "run_id" }),
		coverageId: PG.column(PG.text, { name: "coverage_id" }),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		status: PG.brand(PG.text, UnitStatus),
		wave: PG.int4,
		agentId: PG.column(PG.nullable(PG.text), { name: "agent_id" }),
		unit: PG.jsonb(CoverageUnit),
	},
	primaryKey: ["runId", "coverageId"],
	tenantColumn: "orgId",
})

/** The findings one run holds, as the engine last saved them; replaced whole on every save. */
export const SecurityAuditRunFindings = PG.table("security_audit_run_findings", {
	columns: {
		runId: PG.column(PG.brand(PG.text, SecurityAuditRunId), { name: "run_id" }),
		fingerprint: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		verdict: PG.brand(PG.text, SecurityAuditVerdict),
		/** Confirmed findings only. */
		overallSeverity: PG.column(PG.nullable(PG.brand(PG.text, SecurityAuditSeverity)), {
			name: "overall_severity",
		}),
		record: PG.jsonb(Finding),
	},
	primaryKey: ["runId", "fingerprint"],
	tenantColumn: "orgId",
})

/**
 * A finding followed across a target's runs by fingerprint. The latest run's record and verdict
 * win; `status` is the lifecycle: a `fixed` finding that comes back reopens, a dismissed or
 * accepted one never does.
 */
export const SecurityAuditFindings = PG.table("security_audit_findings", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		targetId: PG.column(PG.brand(PG.text, SecurityAuditTargetId), { name: "target_id" }),
		fingerprint: PG.text,
		verdict: PG.brand(PG.text, SecurityAuditVerdict),
		overallSeverity: PG.column(PG.nullable(PG.brand(PG.text, SecurityAuditSeverity)), {
			name: "overall_severity",
		}),
		record: PG.jsonb(Finding),
		status: PG.column(PG.brand(PG.text, SecurityAuditFindingStatus), { default: "open" }),
		firstSeenRunId: PG.column(PG.brand(PG.text, SecurityAuditRunId), { name: "first_seen_run_id" }),
		lastSeenRunId: PG.column(PG.brand(PG.text, SecurityAuditRunId), { name: "last_seen_run_id" }),
		firstSeenRef: PG.column(PG.text, { name: "first_seen_ref" }),
		lastSeenRef: PG.column(PG.text, { name: "last_seen_ref" }),
		/** The revalidation that no longer found it; cleared when it regresses. */
		fixedRunId: PG.column(PG.nullable(PG.brand(PG.text, SecurityAuditRunId)), { name: "fixed_run_id" }),
		/** Why a person last set `status` (dismissed, accepted risk, reopened); null until one does. */
		statusReason: PG.column(PG.nullable(PG.text), { name: "status_reason" }),
		statusChangedBy: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "status_changed_by" }),
		statusChangedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "status_changed_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("security_audit_findings_target_fingerprint_idx", ["targetId", "fingerprint"]),
		PG.index("security_audit_findings_org_created_idx", ["orgId", "createdAt"]),
	],
	tenantColumn: "orgId",
})

/** What an event says beyond its columns: an agent's message and cost, a phase's detail, a note. */
export const SecurityAuditEventDetail = Schema.Struct({
	message: Schema.NullOr(Schema.String),
	phase: Schema.NullOr(Schema.String),
	detail: Schema.NullOr(Schema.String),
	costUsd: Schema.NullOr(Schema.Number),
})

/** The run's append-only log: agent outcomes, phase transitions and notes. */
export const SecurityAuditEvents = PG.table("security_audit_events", {
	columns: {
		id: PG.text,
		runId: PG.column(PG.brand(PG.text, SecurityAuditRunId), { name: "run_id" }),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		at: PG.timestamptzMillis,
		kind: PG.brand(PG.text, SecurityAuditEventKind),
		role: PG.nullable(PG.text),
		agentId: PG.column(PG.nullable(PG.text), { name: "agent_id" }),
		outcome: PG.nullable(PG.text),
		detail: PG.jsonb(SecurityAuditEventDetail),
		inputTokens: PG.column(PG.nullable(PG.int8), { name: "input_tokens" }),
		outputTokens: PG.column(PG.nullable(PG.int8), { name: "output_tokens" }),
	},
	primaryKey: ["id"],
	indexes: [PG.index("security_audit_events_run_at_idx", ["runId", "at"])],
	tenantColumn: "orgId",
})

/**
 * An org's security-audit agent invocations per UTC month. The Workflow reserves one row unit
 * before every agent step, conditionally on the org's plan limit, so concurrent runs never overspend.
 */
export const SecurityAuditOrgUsage = PG.table("security_audit_org_usage", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** UTC month, `YYYY-MM`. */
		period: PG.text,
		invocationsSpent: PG.column(PG.int4, { name: "invocations_spent", default: 0 }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["orgId", "period"],
	tenantColumn: "orgId",
})

/**
 * One granted invocation per (run, agent): a retried or replayed reservation finds its grant here
 * instead of counting it again in `security_audit_org_usage`. Once the agent answers, its cost is
 * set here too, and the org's monthly spend is their sum.
 */
export const SecurityAuditOrgReservations = PG.table("security_audit_org_reservations", {
	columns: {
		runId: PG.column(PG.brand(PG.text, SecurityAuditRunId), { name: "run_id" }),
		agentId: PG.column(PG.text, { name: "agent_id" }),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		period: PG.text,
		/** What OpenRouter charged for the agent; null until it answers, and for an agent that failed. */
		costUsd: PG.column(PG.nullable(PG.float8), { name: "cost_usd" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["runId", "agentId"],
	indexes: [
		PG.index("security_audit_org_reservations_org_idx", ["orgId", "period"]),
		PG.index("security_audit_org_reservations_org_created_idx", ["orgId", "createdAt"]),
	],
	tenantColumn: "orgId",
})

/** An org's audit settings: its monthly spend limit and default models. No row runs on the defaults. */
export const SecurityAuditOrgSettings = PG.table("security_audit_org_settings", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** Whole US dollars per UTC month; running audits stop once the org's spend reaches it. */
		monthlySpendLimitUsd: PG.column(PG.int4, { name: "monthly_spend_limit_usd" }),
		discoveryModel: PG.column(PG.text, { name: "discovery_model" }),
		validationModel: PG.column(PG.text, { name: "validation_model" }),
		updatedBy: PG.column(PG.brand(PG.text, UserId), { name: "updated_by" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["orgId"],
	tenantColumn: "orgId",
})

export type SecurityAuditTargetRow = PG.SelectRowOf<typeof SecurityAuditTargets>
export type SecurityAuditRunRow = PG.SelectRowOf<typeof SecurityAuditRuns>
export type SecurityAuditUnitRow = PG.SelectRowOf<typeof SecurityAuditUnits>
export type SecurityAuditRunFindingRow = PG.SelectRowOf<typeof SecurityAuditRunFindings>
export type SecurityAuditFindingRow = PG.SelectRowOf<typeof SecurityAuditFindings>
export type SecurityAuditEventRow = PG.SelectRowOf<typeof SecurityAuditEvents>
export type SecurityAuditOrgUsageRow = PG.SelectRowOf<typeof SecurityAuditOrgUsage>
export type SecurityAuditOrgSettingsRow = PG.SelectRowOf<typeof SecurityAuditOrgSettings>
