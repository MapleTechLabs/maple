import { HttpApiBuilder } from "effect/http-api"
import {
	CurrentTenant,
	MapleAiApi,
	DEFAULT_RUN_BUDGET,
	SECURITY_AUDIT_EVENTS_DEFAULT_LIMIT,
	SecurityAuditBudgetExhaustedError,
	SecurityAuditRepositoryTooLargeError,
	SECURITY_AUDIT_MAX_BUDGET,
	SecurityAuditDisabledError,
	type SecurityAuditEvent,
	type SecurityAuditFinding,
	SecurityAuditFindingNotFoundError,
	SecurityAuditForbiddenError,
	SecurityAuditPersistenceError,
	SecurityAuditRepositoryNotConnectedError,
	SecurityAuditRunInProgressError,
	SecurityAuditRunNotInProgressError,
	type SecurityAuditUnit,
	SecurityAuditTargetDisabledError,
	SecurityAuditTargetExistsError,
	type SecurityAuditRun,
	SecurityAuditRunNotFoundError,
	SecurityAuditStartError,
	type SecurityAuditTarget,
	SecurityAuditTargetNotFoundError,
} from "@maple/domain/http"
import {
	securityAuditBudgetPeriod,
	SecurityAuditRunId,
	type SecurityAuditTargetId,
	type SecurityAuditWorkflowPayload,
} from "@maple/domain/security-audit"
import type { SecurityAuditFindingRow, SecurityAuditRunRow, SecurityAuditTargetRow } from "@maple/db/tables"
import { AuditStoreError, minimumInvocations } from "@maple/security-audit"
import { Clock, Effect, Option, Schema } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { SecurityAuditWorkflowStarter } from "@maple/backend/platform/bindings"
import { requireAdmin } from "@maple/backend/services/auth/auth"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { securityAuditLimits } from "@maple/backend/services/security-audit/limits"
import { SecurityAuditPlanBudget } from "@maple/backend/services/security-audit/SecurityAuditPlanBudget"
import { SecurityAuditRepositorySize } from "@maple/backend/services/security-audit/SecurityAuditRepositorySize"
import { hostedSizeViolations, refusalReason } from "../security-audit/repo-size"
import {
	type SecurityAuditEventRecord,
	type SecurityAuditOrgStore,
	SecurityAuditStore,
	type SecurityAuditUnitSummary,
} from "@maple/backend/services/security-audit/SecurityAuditStore"

const toTarget = (row: SecurityAuditTargetRow): SecurityAuditTarget => ({
	id: row.id,
	repository: row.repository,
	branch: row.branch,
	enabled: row.enabled,
	profile: row.profile,
	scopePaths: row.scopePaths,
	budgetPerRun: row.budgetPerRun,
	createdBy: row.createdBy,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
})

const toRun = (row: SecurityAuditRunRow): SecurityAuditRun => ({
	id: row.id,
	targetId: row.targetId,
	kind: row.kind,
	status: row.status,
	sourceRef: row.sourceRef,
	profile: row.profile,
	scopePaths: row.scopePaths,
	budget: row.budget,
	invocationsSpent: row.invocationsSpent,
	inputTokens: row.inputTokens,
	outputTokens: row.outputTokens,
	costUsd: row.costUsd,
	incompleteReason: row.incompleteReason,
	error: row.error,
	startedAt: row.startedAt,
	finishedAt: row.finishedAt,
})

const toEvent = (row: SecurityAuditEventRecord): SecurityAuditEvent => ({
	id: row.id,
	at: row.at,
	kind: row.kind,
	role: row.role,
	agentId: row.agentId,
	outcome: row.outcome,
	message: row.detail?.message ?? null,
	phase: row.detail?.phase ?? null,
	detail: row.detail?.detail ?? null,
	costUsd: row.detail?.costUsd ?? null,
	inputTokens: row.inputTokens,
	outputTokens: row.outputTokens,
})

const toFinding = (row: SecurityAuditFindingRow): SecurityAuditFinding => ({
	fingerprint: row.fingerprint,
	targetId: row.targetId,
	verdict: row.verdict,
	overallSeverity: row.overallSeverity,
	status: row.status,
	statusReason: row.statusReason,
	statusChangedBy: row.statusChangedBy,
	statusChangedAt: row.statusChangedAt,
	record: row.record,
	firstSeenRunId: row.firstSeenRunId,
	lastSeenRunId: row.lastSeenRunId,
	firstSeenRef: row.firstSeenRef,
	lastSeenRef: row.lastSeenRef,
	fixedRunId: row.fixedRunId,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
})

/** Each unresolved note trimmed, and only the first few: the list stays lean for large ledgers. */
const MAX_UNRESOLVED = 3
const MAX_UNRESOLVED_CHARS = 300
const MAX_RESULT_FINGERPRINTS = 20

const toUnit = (row: SecurityAuditUnitSummary): SecurityAuditUnit => ({
	coverageId: row.coverageId,
	status: row.status,
	wave: row.wave,
	agentId: row.agentId,
	stale: row.fields === null,
	subsystem: row.fields?.subsystem ?? null,
	surface: row.fields?.surface ?? null,
	boundary: row.fields?.boundary ?? null,
	attackClass: row.fields?.attack_class ?? null,
	priorStatus: row.fields?.prior_status ?? null,
	priority: row.fields?.priority ?? null,
	failedAttempts: row.fields?.failed_attempts ?? null,
	resultFingerprints: (row.fields?.result_fingerprints ?? []).slice(0, MAX_RESULT_FINGERPRINTS),
	carriedFingerprint: row.fields?.carried_fingerprint ?? null,
	unresolved: (row.fields?.unresolved ?? [])
		.slice(0, MAX_UNRESOLVED)
		.map((note) => note.slice(0, MAX_UNRESOLVED_CHARS)),
})

/** A store failure is the database's, never the caller's: a 503 that names the operation. */
const orUnavailable = <A, E, R>(effect: Effect.Effect<A, E | AuditStoreError, R>) =>
	effect.pipe(
		Effect.catchIf(
			(error): error is AuditStoreError => error instanceof AuditStoreError,
			(error) =>
				Effect.fail(
					new SecurityAuditPersistenceError({
						message: "Security audit storage is unavailable",
						cause: error.message,
					}),
				),
		),
	)

/**
 * The request's budget, else the target's, else the default; never above the hard cap or what the
 * org has left this month.
 */
const resolveBudget = (requested: number | undefined, targetBudget: number | null, orgRemaining: number) =>
	Math.min(requested ?? targetBudget ?? DEFAULT_RUN_BUDGET, SECURITY_AUDIT_MAX_BUDGET, orgRemaining)

const newRunId = () => Schema.decodeSync(SecurityAuditRunId)(crypto.randomUUID())

/** `/api/security-audit/*`: targets, runs and findings for the caller's org, behind `securityAudit`. */
export const HttpSecurityAuditLive = HttpApiBuilder.group(MapleAiApi, "securityAudit", (handlers) =>
	Effect.gen(function* () {
		const stores = yield* SecurityAuditStore
		const featureFlags = yield* OrganizationFeatureFlagsService
		const workflow = yield* SecurityAuditWorkflowStarter
		const planBudget = yield* SecurityAuditPlanBudget
		const repositorySize = yield* SecurityAuditRepositorySize

		/** The caller's org store, once the org is in the rollout. The org is the tenant's, never the request's. */
		const orgAccess = Effect.gen(function* () {
			const tenant = yield* CurrentTenant.Context
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
			const flags = yield* featureFlags.flags(tenant.orgId)
			if (!flags.securityAudit) {
				return yield* new SecurityAuditDisabledError({
					message: "Security audits are not enabled for this organization.",
				})
			}
			return { tenant, store: stores.forOrg(tenant.orgId) }
		})

		const adminAccess = orgAccess.pipe(
			Effect.tap(({ tenant }) =>
				requireAdmin(
					tenant.roles,
					() =>
						new SecurityAuditForbiddenError({
							message: "Only org admins can manage security audits.",
						}),
				),
			),
		)

		/** Refuses a repository GitHub already reports as over the limit, before anything is cloned. */
		const refuseOversized = (orgId: SecurityAuditTargetRow["orgId"], repository: string) =>
			Effect.gen(function* () {
				const bytes = yield* repositorySize.bytes(orgId, repository)
				if (Option.isNone(bytes)) return
				const violations = hostedSizeViolations(bytes.value, yield* securityAuditLimits)
				if (violations.length === 0) return
				return yield* new SecurityAuditRepositoryTooLargeError({
					message: refusalReason(violations),
					repository,
				})
			})

		const requireTarget = (store: SecurityAuditOrgStore, targetId: SecurityAuditTargetId) =>
			orUnavailable(store.getTarget(targetId)).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () =>
							Effect.fail(
								new SecurityAuditTargetNotFoundError({
									message: "This organization has no audit target with that id.",
									targetId,
								}),
							),
						onSome: Effect.succeed,
					}),
				),
			)

		const requireRun = (store: SecurityAuditOrgStore, runId: SecurityAuditRunRow["id"]) =>
			orUnavailable(store.getRun(runId)).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () =>
							Effect.fail(
								new SecurityAuditRunNotFoundError({
									message: "This organization has no audit run with that id.",
									runId,
								}),
							),
						onSome: Effect.succeed,
					}),
				),
			)

		/** Marks a run whose Workflow never started as failed, so it does not read as running forever. */
		const failUnstarted = (
			store: SecurityAuditOrgStore,
			runId: SecurityAuditRunRow["id"],
			message: string,
		) =>
			store
				.finishRun(runId, { status: "failed", error: `The audit workflow did not start: ${message}` })
				.pipe(
					Effect.catch((error) =>
						Effect.logError("Could not mark an unstarted security audit run failed").pipe(
							Effect.annotateLogs({ runId, error: error.message }),
						),
					),
					Effect.andThen(
						Effect.fail(
							new SecurityAuditStartError({
								message: "The audit could not start.",
								runId,
								cause: message,
							}),
						),
					),
				)

		return handlers
			.handle("createTarget", ({ payload }) =>
				Effect.gen(function* () {
					const { tenant, store } = yield* adminAccess
					const repository = yield* orUnavailable(store.findConnectedRepository(payload.repository))
					if (Option.isNone(repository)) {
						return yield* new SecurityAuditRepositoryNotConnectedError({
							message:
								"Security audits read GitHub repositories only. Connect this repository through the GitHub integration first.",
							repository: payload.repository,
						})
					}
					yield* refuseOversized(tenant.orgId, repository.value.fullName)
					const row = yield* orUnavailable(
						store.createTarget({
							...payload,
							repository: repository.value.fullName,
							vcsRepositoryId: repository.value.id,
							createdBy: tenant.userId,
						}),
					).pipe(
						Effect.catchTag("@maple/backend/security-audit/TargetExists", () =>
							Effect.fail(
								new SecurityAuditTargetExistsError({
									message: "This repository branch is already an audit target.",
								}),
							),
						),
					)
					return toTarget(row)
				}).pipe(Effect.withSpan("HttpSecurityAudit.createTarget")),
			)
			.handle("listTargets", () =>
				Effect.gen(function* () {
					const { store } = yield* orgAccess
					const rows = yield* orUnavailable(store.listTargets())
					return { targets: rows.map(toTarget) }
				}).pipe(Effect.withSpan("HttpSecurityAudit.listTargets")),
			)
			.handle("startRun", ({ params, payload }) =>
				Effect.gen(function* () {
					const { tenant, store } = yield* adminAccess
					const target = yield* requireTarget(store, params.targetId)
					yield* refuseOversized(tenant.orgId, target.repository)
					const prior = yield* orUnavailable(store.latestPriorRun(target.id))
					const runId = newRunId()
					// The org's month: its plan's limit less what its runs already reserved.
					const period = securityAuditBudgetPeriod(yield* Clock.currentTimeMillis)
					const orgLimit = yield* planBudget.monthlyLimit(tenant.orgId).pipe(
						Effect.catchTag("@maple/backend/security-audit/PlanUnavailable", (error) =>
							Effect.fail(
								new SecurityAuditPersistenceError({
									message: "Could not confirm the organization's plan with billing.",
									cause: error.message,
								}),
							),
						),
					)
					const orgRemaining = Math.max(
						0,
						orgLimit - (yield* orUnavailable(store.orgInvocationsSpent(period))),
					)
					const required = minimumInvocations(target.profile)
					if (orgRemaining < required) {
						return yield* new SecurityAuditBudgetExhaustedError({
							message:
								orgLimit === 0
									? "This organization's plan does not include security audit invocations."
									: `This organization has ${orgRemaining} security audit invocations left this month; a ${target.profile} run needs at least ${required}.`,
							remaining: orgRemaining,
							required,
						})
					}
					const budget = resolveBudget(payload.budget, target.budgetPerRun, orgRemaining)
					// The branch for now; the Workflow pins the commit it resolves to before any agent runs.
					const run = yield* orUnavailable(
						store.startRun({
							runId,
							targetId: target.id,
							kind: "manual",
							sourceRef: target.branch,
							workflowInstanceId: runId,
							scopePaths: payload.scopePaths ?? target.scopePaths,
							budget,
						}),
					).pipe(
						Effect.catchTags({
							"@maple/backend/security-audit/RunInProgress": () =>
								Effect.fail(
									new SecurityAuditRunInProgressError({
										message: "This target already has an audit in progress.",
										targetId: target.id,
									}),
								),
							"@maple/backend/security-audit/TargetDisabled": () =>
								Effect.fail(
									new SecurityAuditTargetDisabledError({
										message: "This audit target is disabled.",
										targetId: target.id,
									}),
								),
						}),
					)
					const workflowPayload: SecurityAuditWorkflowPayload = {
						orgId: tenant.orgId,
						runId: run.id,
						repository: target.repository,
						ref: target.branch,
						profile: run.profile,
						scopePaths: run.scopePaths,
						budget,
						priorRunId: Option.match(prior, { onNone: () => null, onSome: (r) => r.id }),
						orgBudget: { period, limit: orgLimit },
					}
					yield* workflow
						.create(workflowPayload)
						.pipe(Effect.catch((error) => failUnstarted(store, run.id, error.message)))
					return toRun(run)
				}).pipe(Effect.withSpan("HttpSecurityAudit.startRun")),
			)
			.handle("listRuns", ({ query }) =>
				Effect.gen(function* () {
					const { store } = yield* orgAccess
					const rows = yield* orUnavailable(
						store.listRuns(query.targetId === undefined ? {} : { targetId: query.targetId }),
					)
					return { runs: rows.map(toRun) }
				}).pipe(Effect.withSpan("HttpSecurityAudit.listRuns")),
			)
			.handle("getRun", ({ params }) =>
				Effect.gen(function* () {
					const { store } = yield* adminAccess
					const run = yield* requireRun(store, params.runId)
					const unitCounts = yield* orUnavailable(store.countUnits(run.id))
					return {
						...toRun(run),
						reports: run.reports,
						architectureMd: run.architectureMd,
						executionProfile: run.executionProfile,
						unitCounts,
						unitTotal: Object.values(unitCounts).reduce((sum, n) => sum + n, 0),
					}
				}).pipe(Effect.withSpan("HttpSecurityAudit.getRun")),
			)
			.handle("cancelRun", ({ params }) =>
				Effect.gen(function* () {
					const { tenant, store } = yield* adminAccess
					const run = yield* requireRun(store, params.runId)
					const notInProgress = new SecurityAuditRunNotInProgressError({
						message: "This audit run has already finished.",
						runId: run.id,
					})
					// Finished means settled: the engine may already say complete while settle has not run.
					if (run.finishedAt !== null) return yield* notInProgress
					// Stop the agents first; the row is only marked once nothing can still settle it.
					yield* workflow.cancel(run.id).pipe(
						Effect.catchTag("@maple/backend/platform/WorkflowCancelError", (error) =>
							Effect.fail(
								new SecurityAuditPersistenceError({
									message: "The audit could not be cancelled.",
									cause: error.message,
								}),
							),
						),
					)
					const cancelled = yield* orUnavailable(store.cancelRun(run.id, tenant.userId))
					// Settled between the read and the write: its own outcome stands.
					if (Option.isNone(cancelled)) return yield* notInProgress
					yield* recordHttpAudit("security_audit_run.cancelled", {
						metadata: { targetId: run.targetId, runId: run.id },
					})
					return toRun(cancelled.value)
				}).pipe(Effect.withSpan("HttpSecurityAudit.cancelRun")),
			)
			.handle("listRunUnits", ({ params }) =>
				Effect.gen(function* () {
					const { store } = yield* adminAccess
					const run = yield* requireRun(store, params.runId)
					const rows = yield* orUnavailable(store.listUnitSummaries(run.id))
					return { units: rows.map(toUnit) }
				}).pipe(Effect.withSpan("HttpSecurityAudit.listRunUnits")),
			)
			.handle("listRunEvents", ({ params, query }) =>
				Effect.gen(function* () {
					const { store } = yield* adminAccess
					const run = yield* requireRun(store, params.runId)
					const rows = yield* orUnavailable(
						store.listEvents(run.id, {
							limit: query.limit ?? SECURITY_AUDIT_EVENTS_DEFAULT_LIMIT,
							beforeAt: query.beforeAt,
							beforeId: query.beforeId,
						}),
					)
					return { events: rows.map(toEvent) }
				}).pipe(Effect.withSpan("HttpSecurityAudit.listRunEvents")),
			)
			.handle("listFindings", ({ params, query }) =>
				Effect.gen(function* () {
					const { store } = yield* adminAccess
					const target = yield* requireTarget(store, params.targetId)
					const rows = yield* orUnavailable(store.listFindings(target.id))
					const includeRejected = query.includeRejected === "true"
					return {
						findings: rows
							.filter((row) => includeRejected || row.verdict !== "rejected")
							.map(toFinding),
					}
				}).pipe(Effect.withSpan("HttpSecurityAudit.listFindings")),
			)
			.handle("updateFindingStatus", ({ params, payload }) =>
				Effect.gen(function* () {
					const { tenant, store } = yield* adminAccess
					const updated = yield* orUnavailable(
						store.setFindingStatus(
							params.targetId,
							params.fingerprint,
							payload.status,
							payload.reason,
							tenant.userId,
						),
					)
					if (Option.isNone(updated)) {
						return yield* new SecurityAuditFindingNotFoundError({
							message: "This audit target has no finding with that fingerprint.",
							targetId: params.targetId,
							fingerprint: params.fingerprint,
						})
					}
					yield* recordHttpAudit("security_audit_finding.triaged", {
						metadata: {
							targetId: params.targetId,
							fingerprint: params.fingerprint,
							status: payload.status,
							reason: payload.reason,
						},
					})
					return { targetId: params.targetId, ...updated.value }
				}).pipe(Effect.withSpan("HttpSecurityAudit.updateFindingStatus")),
			)
	}),
)
