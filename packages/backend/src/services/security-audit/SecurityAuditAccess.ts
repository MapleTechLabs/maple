/**
 * The Security Center's audit access checks and its read handlers, shared by the two Workers that
 * serve `/api/security-audit/*`: api answers the reads (it stays warm), ai the writes that start
 * or settle the Workflow it hosts.
 */
import {
	CurrentTenant,
	SECURITY_AUDIT_EVENTS_DEFAULT_LIMIT,
	SecurityAuditDisabledError,
	SecurityAuditForbiddenError,
	type SecurityAuditListEventsQuery,
	type SecurityAuditListFindingsQuery,
	type SecurityAuditListRunsQuery,
	SecurityAuditPersistenceError,
	SecurityAuditRunNotFoundError,
	SecurityAuditTargetNotFoundError,
} from "@maple/domain/http"
import type { SecurityAuditRunId, SecurityAuditTargetId } from "@maple/domain/security-audit"
import * as Policy from "@maple/domain/policy"
import { AuditStoreError } from "@maple/security-audit"
import { Context, Effect, Layer, Option, Schema, Array as Arr, Record as Rec } from "effect"
import { OrganizationFeatureFlagsService } from "../org/OrganizationFeatureFlagsService"
import {
	securityAuditEventView,
	securityAuditFindingView,
	type SecurityAuditOrgStore,
	securityAuditRunView,
	SecurityAuditStore,
	securityAuditTargetView,
	securityAuditUnitView,
} from "./SecurityAuditStore"

/** A store failure is the database's, never the caller's: a 503 that names the operation. */
export const orUnavailable = <A, E, R>(effect: Effect.Effect<A, E | AuditStoreError, R>) =>
	effect.pipe(
		Effect.catchIf(Schema.is(AuditStoreError), (error) =>
			Effect.fail(
				new SecurityAuditPersistenceError({
					message: "Security audit storage is unavailable",
					cause: error.message,
				}),
			),
		),
	)

const make = Effect.gen(function* () {
	const stores = yield* SecurityAuditStore
	const featureFlags = yield* OrganizationFeatureFlagsService

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

	const accessFor = (permission: Policy.Permission) =>
		orgAccess.pipe(
			Effect.tap(({ tenant }) =>
				Policy.check(
					tenant.permissions,
					permission,
					(denial) => new SecurityAuditForbiddenError({ message: denial.message }),
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

	const requireRun = (store: SecurityAuditOrgStore, runId: SecurityAuditRunId) =>
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

	/** Anything that reads or triages: the whole Security Center is for engineers and admins. */
	const readAccess = accessFor("security:manage")
	/** Anything that spends the audit budget: targets, settings, starting or stopping runs. */
	const auditAccess = accessFor("security_audit:run")

	const listTargets = Effect.gen(function* () {
		const { store } = yield* readAccess
		const rows = yield* orUnavailable(store.listTargets)
		return { targets: Arr.map(rows, securityAuditTargetView) }
	}).pipe(Effect.withSpan("HttpSecurityAudit.listTargets"))

	const listRuns = Effect.fn("HttpSecurityAudit.listRuns")(function* (
		query: typeof SecurityAuditListRunsQuery.Type,
	) {
		const { store } = yield* readAccess
		const rows = yield* orUnavailable(
			store.listRuns(query.targetId === undefined ? {} : { targetId: query.targetId }),
		)
		const findingCounts = yield* orUnavailable(store.countRunFindings(Arr.map(rows, (r) => r.id)))
		return { runs: Arr.map(rows, securityAuditRunView), findingCounts }
	})

	const getRun = Effect.fn("HttpSecurityAudit.getRun")(function* (runId: SecurityAuditRunId) {
		const { store } = yield* readAccess
		const run = yield* requireRun(store, runId)
		const unitCounts = yield* orUnavailable(store.countUnits(run.id))
		return {
			...securityAuditRunView(run),
			reports: run.reports,
			architectureMd: run.architectureMd,
			executionProfile: run.executionProfile,
			unitCounts,
			unitTotal: Arr.reduce(Rec.values(unitCounts), 0, (sum, n) => sum + n),
		}
	})

	const listRunUnits = Effect.fn("HttpSecurityAudit.listRunUnits")(function* (runId: SecurityAuditRunId) {
		const { store } = yield* readAccess
		const run = yield* requireRun(store, runId)
		const rows = yield* orUnavailable(store.listUnitSummaries(run.id))
		return { units: Arr.map(rows, securityAuditUnitView) }
	})

	const listRunEvents = Effect.fn("HttpSecurityAudit.listRunEvents")(function* (
		runId: SecurityAuditRunId,
		query: typeof SecurityAuditListEventsQuery.Type,
	) {
		const { store } = yield* readAccess
		const run = yield* requireRun(store, runId)
		const rows = yield* orUnavailable(
			store.listEvents(run.id, {
				limit: query.limit ?? SECURITY_AUDIT_EVENTS_DEFAULT_LIMIT,
				beforeAt: query.beforeAt,
				beforeId: query.beforeId,
			}),
		)
		return { events: Arr.map(rows, securityAuditEventView) }
	})

	const listRunFindings = Effect.fn("HttpSecurityAudit.listRunFindings")(function* (
		runId: SecurityAuditRunId,
	) {
		const { store } = yield* readAccess
		const run = yield* requireRun(store, runId)
		const rows = yield* orUnavailable(store.listRunFindingViews(run.id))
		return { findings: Arr.map(rows, securityAuditFindingView) }
	})

	const listFindings = Effect.fn("HttpSecurityAudit.listFindings")(function* (
		targetId: SecurityAuditTargetId,
		query: typeof SecurityAuditListFindingsQuery.Type,
	) {
		const { store } = yield* readAccess
		const target = yield* requireTarget(store, targetId)
		const rows = yield* orUnavailable(store.listFindings(target.id))
		const includeRejected = query.includeRejected === "true"
		return {
			findings: Arr.map(
				Arr.filter(rows, (row) => includeRejected || row.verdict !== "rejected"),
				securityAuditFindingView,
			),
		}
	})

	return {
		readAccess,
		auditAccess,
		requireTarget,
		requireRun,
		listTargets,
		listRuns,
		getRun,
		listRunUnits,
		listRunEvents,
		listRunFindings,
		listFindings,
	}
})

/** The rollout gate, the role checks, and every read a Security Center audit page makes. */
export class SecurityAuditAccess extends Context.Service<SecurityAuditAccess, Effect.Success<typeof make>>()(
	"@maple/backend/services/security-audit/SecurityAuditAccess",
	{ make },
) {
	/** Over the caller's own store and flags, as the tests provide them. */
	static readonly layerWithoutDependencies = Layer.effect(this, this.make)

	static readonly layer = this.layerWithoutDependencies.pipe(
		Layer.provide([SecurityAuditStore.layer, OrganizationFeatureFlagsService.layer]),
	)
}
