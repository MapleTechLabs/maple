import { HttpApiBuilder } from "effect/http-api"
import {
	CurrentTenant,
	MapleAiApi,
	SecurityAuditDisabledError,
	type SecurityAuditEvent,
	type SecurityAuditFinding,
	SecurityAuditFindingNotFoundError,
	SecurityAuditForbiddenError,
	SecurityAuditPersistenceError,
	type SecurityAuditRun,
	SecurityAuditRunNotFoundError,
	SecurityAuditStartError,
	type SecurityAuditTarget,
	SecurityAuditTargetNotFoundError,
} from "@maple/domain/http"
import {
	SecurityAuditRunId,
	type SecurityAuditTargetId,
	type SecurityAuditWorkflowPayload,
} from "@maple/domain/security-audit"
import type {
	SecurityAuditEventRow,
	SecurityAuditFindingRow,
	SecurityAuditRunRow,
	SecurityAuditTargetRow,
} from "@maple/db/tables"
import type { AuditStoreError } from "@maple/security-audit"
import { Array as Arr, Effect, Option, Record as Rec, Schema } from "effect"
import { SecurityAuditWorkflowStarter } from "@maple/backend/platform/bindings"
import { requireAdmin } from "@maple/backend/services/auth/auth"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import {
	type SecurityAuditOrgStore,
	SecurityAuditStore,
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

const toEvent = (row: SecurityAuditEventRow): SecurityAuditEvent => ({
	id: row.id,
	at: row.at,
	kind: row.kind,
	role: row.role,
	agentId: row.agentId,
	outcome: row.outcome,
	message: row.detail.message,
	phase: row.detail.phase,
	detail: row.detail.detail,
	costUsd: row.detail.costUsd,
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

/** A store failure is the database's, never the caller's: a 503 that names the operation. */
const orUnavailable = <A, R>(effect: Effect.Effect<A, AuditStoreError, R>) =>
	effect.pipe(
		Effect.mapError(
			(error) =>
				new SecurityAuditPersistenceError({
					message: "Security audit storage is unavailable",
					cause: error.message,
				}),
		),
	)

const newRunId = () => Schema.decodeSync(SecurityAuditRunId)(crypto.randomUUID())

/** A new run carries forward the findings of the target's latest run that finished. */
const PRIOR_RUN_STATUSES = ["complete", "incomplete"] as const

/** `/api/security-audit/*`: targets, runs and findings for the caller's org, behind `securityAudit`. */
export const HttpSecurityAuditLive = HttpApiBuilder.group(MapleAiApi, "securityAudit", (handlers) =>
	Effect.gen(function* () {
		const stores = yield* SecurityAuditStore
		const featureFlags = yield* OrganizationFeatureFlagsService
		const workflow = yield* SecurityAuditWorkflowStarter

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
					const row = yield* orUnavailable(
						store.createTarget({ ...payload, createdBy: tenant.userId }),
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
					const prior = yield* orUnavailable(
						store.listRuns({ targetId: target.id, statuses: PRIOR_RUN_STATUSES, limit: 1 }),
					)
					const runId = newRunId()
					// The branch for now; the Workflow pins the commit it resolves to before any agent runs.
					const run = yield* orUnavailable(
						store.startRun({
							runId,
							targetId: target.id,
							kind: payload.kind ?? "manual",
							sourceRef: target.branch,
							workflowInstanceId: runId,
							scopePaths: payload.scopePaths ?? target.scopePaths,
							budget: payload.budget ?? target.budgetPerRun,
						}),
					)
					const workflowPayload: SecurityAuditWorkflowPayload = {
						orgId: tenant.orgId,
						runId: run.id,
						repository: target.repository,
						ref: target.branch,
						profile: run.profile,
						scopePaths: run.scopePaths,
						budget: run.budget,
						priorRunId: prior[0]?.id ?? null,
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
					const { store } = yield* orgAccess
					const run = yield* requireRun(store, params.runId)
					const units = yield* orUnavailable(store.listUnits(run.id))
					const unitCounts = Rec.map(
						Arr.groupBy(units, (unit): string => unit.status),
						(group) => group.length,
					)
					return {
						...toRun(run),
						reports: run.reports,
						architectureMd: run.architectureMd,
						unitCounts,
						unitTotal: units.length,
					}
				}).pipe(Effect.withSpan("HttpSecurityAudit.getRun")),
			)
			.handle("listRunEvents", ({ params }) =>
				Effect.gen(function* () {
					const { store } = yield* orgAccess
					const run = yield* requireRun(store, params.runId)
					const rows = yield* orUnavailable(store.listEvents(run.id))
					return { events: rows.map(toEvent) }
				}).pipe(Effect.withSpan("HttpSecurityAudit.listRunEvents")),
			)
			.handle("listFindings", ({ params, query }) =>
				Effect.gen(function* () {
					const { store } = yield* orgAccess
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
					return yield* Option.match(updated, {
						onNone: () =>
							Effect.fail(
								new SecurityAuditFindingNotFoundError({
									message: "This audit target has no finding with that fingerprint.",
									targetId: params.targetId,
									fingerprint: params.fingerprint,
								}),
							),
						onSome: (row) => Effect.succeed(toFinding(row)),
					})
				}).pipe(Effect.withSpan("HttpSecurityAudit.updateFindingStatus")),
			)
	}),
)
