import { HttpApiBuilder } from "effect/http-api"
import * as SecureRandom from "effect/crypto/SecureRandom"
import {
	CurrentTenant,
	MapleAiApi,
	SecurityAuditCreditsUsedUpError,
	SECURITY_AUDIT_EVENTS_DEFAULT_LIMIT,
	SecurityAuditRepositoryTooLargeError,
	SecurityAuditDisabledError,
	SecurityAuditFindingNotFoundError,
	SecurityAuditForbiddenError,
	SecurityAuditNotInPlanError,
	SecurityAuditPersistenceError,
	SecurityAuditRepositoryNotConnectedError,
	SecurityAuditRunInProgressError,
	SecurityAuditRunNotInProgressError,
	SecurityAuditSameModelsError,
	type SecurityAuditSettings,
	SecurityAuditSpendLimitReachedError,
	SecurityAuditTargetDisabledError,
	SecurityAuditTargetExistsError,
	SecurityAuditRunNotFoundError,
	SecurityAuditStartError,
	SecurityAuditTargetNotFoundError,
} from "@maple/domain/http"
import { IsoDateTimeString } from "@maple/primitives"
import {
	SecurityAuditRunId,
	securityAuditSpendWindow,
	type SecurityAuditTargetId,
	type SecurityAuditWorkflowPayload,
} from "@maple/domain/security-audit"
import type { SecurityAuditRunRow, SecurityAuditTargetRow } from "@maple/db/tables"
import { AuditStoreError } from "@maple/security-audit"
import { Clock, DateTime, Effect, Layer, Option, Schema, Array as Arr, Record as Rec } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { SecurityAuditWorkflowStarter } from "@maple/backend/platform/bindings"
import * as Policy from "@maple/domain/policy"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { securityAuditLimits } from "@maple/backend/services/security-audit/limits"
import { AiCredits } from "@maple/backend/services/billing/AiCredits"
import { SecurityAuditRepositorySize } from "@maple/backend/services/security-audit/SecurityAuditRepositorySize"
import { hostedSizeViolations, refusalReason } from "../security-audit/repo-size"
import { loadLlmSettings, securityAuditModelIds } from "../platform/Llm"
import {
	securityAuditEventView,
	securityAuditFindingView,
	type SecurityAuditOrgStore,
	securityAuditRunView,
	SecurityAuditStore,
	securityAuditTargetView,
	securityAuditUnitView,
} from "@maple/backend/services/security-audit/SecurityAuditStore"

/** A store failure is the database's, never the caller's: a 503 that names the operation. */
const orUnavailable = <A, E, R>(effect: Effect.Effect<A, E | AuditStoreError, R>) =>
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

/** Verification on the hunter's model shares the hunter's blind spots: refused as the caller's to fix. */
const requireDistinctModels = (discovery: string, validation: string) =>
	discovery === validation
		? Effect.fail(
				new SecurityAuditSameModelsError({
					message:
						"Verification must run on a different model than hunting, so it does not share the hunter's blind spots.",
					model: discovery,
				}),
			)
		: Effect.void

const decodeRunId = Schema.decodeSync(SecurityAuditRunId)
const decodeIso = Schema.decodeSync(IsoDateTimeString)

/** `/api/security-audit/*`: targets, runs and findings for the caller's org, behind `securityAudit`. */
export const HttpSecurityAuditLive = HttpApiBuilder.group(MapleAiApi, "securityAudit", (handlers) =>
	Effect.gen(function* () {
		const stores = yield* SecurityAuditStore
		const featureFlags = yield* OrganizationFeatureFlagsService
		const workflow = yield* SecurityAuditWorkflowStarter
		const credits = yield* AiCredits
		const repositorySize = yield* SecurityAuditRepositorySize
		const random = yield* SecureRandom.SecureRandom

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
						tenant.roles,
						permission,
						(denial) => new SecurityAuditForbiddenError({ message: denial.message }),
					),
				),
			)
		/** Anything that reads or triages: the whole Security Center is for engineers and admins. */
		const readAccess = accessFor("security:manage")
		/** Anything that spends the audit budget: targets, settings, starting or stopping runs. */
		const auditAccess = accessFor("security_audit:run")

		/**
		 * The org's spend limit, what it spent this UTC month, and its models (the org's picks, else
		 * the deployment's defaults, as this region serves them).
		 */
		const orgSettings = (store: SecurityAuditOrgStore) =>
			Effect.gen(function* () {
				const settings = yield* orUnavailable(store.getSettings)
				const row = Option.getOrNull(settings)
				const llm = yield* loadLlmSettings
				const now = yield* Clock.currentTimeMillis
				const window = securityAuditSpendWindow(now)
				const spentUsd = yield* orUnavailable(store.orgSpendUsd(window.since))
				const models = securityAuditModelIds(llm, {
					discovery: row?.discoveryModel ?? null,
					validation: row?.validationModel ?? null,
				})
				return {
					monthlySpendLimitUsd:
						row?.monthlySpendLimitUsd ?? (yield* securityAuditLimits).defaultMonthlySpendLimitUsd,
					spentUsd,
					since: window.since,
					resetsAt: window.resetsAt,
					discoveryModel: models.discovery,
					validationModel: models.validation,
				} satisfies SecurityAuditSettings
			})

		/** Refuses a repository GitHub already reports as over the limit, before anything is cloned. */
		const refuseOversized = (orgId: SecurityAuditTargetRow["orgId"], repository: string) =>
			Effect.gen(function* () {
				const bytes = yield* repositorySize.bytes(orgId, repository)
				if (Option.isNone(bytes)) return
				const limits = yield* securityAuditLimits
				const violations = hostedSizeViolations(bytes.value, limits)
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
					const { tenant, store } = yield* auditAccess
					if (payload.discoveryModel !== undefined || payload.validationModel !== undefined) {
						const org = yield* orgSettings(store)
						yield* requireDistinctModels(
							payload.discoveryModel ?? org.discoveryModel,
							payload.validationModel ?? org.validationModel,
						)
					}
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
					return securityAuditTargetView(row)
				}).pipe(Effect.withSpan("HttpSecurityAudit.createTarget")),
			)
			.handle("getSettings", () =>
				Effect.gen(function* () {
					const { store } = yield* readAccess
					return yield* orgSettings(store)
				}).pipe(Effect.withSpan("HttpSecurityAudit.getSettings")),
			)
			.handle("updateSettings", ({ payload }) =>
				Effect.gen(function* () {
					const { tenant, store } = yield* auditAccess
					yield* requireDistinctModels(payload.discoveryModel, payload.validationModel)
					yield* orUnavailable(store.saveSettings({ ...payload, updatedBy: tenant.userId }))
					yield* recordHttpAudit("security_audit_settings.updated", { metadata: { ...payload } })
					return yield* orgSettings(store)
				}).pipe(Effect.withSpan("HttpSecurityAudit.updateSettings")),
			)
			.handle("listTargets", () =>
				Effect.gen(function* () {
					const { store } = yield* readAccess
					const rows = yield* orUnavailable(store.listTargets)
					return { targets: Arr.map(rows, securityAuditTargetView) }
				}).pipe(Effect.withSpan("HttpSecurityAudit.listTargets")),
			)
			.handle("startRun", ({ params, payload }) =>
				Effect.gen(function* () {
					const { tenant, store } = yield* auditAccess
					const target = yield* requireTarget(store, params.targetId)
					// The org's own limit first: it is the one an admin can raise right away.
					const org = yield* orgSettings(store)
					if (org.spentUsd >= org.monthlySpendLimitUsd) {
						return yield* new SecurityAuditSpendLimitReachedError({
							message: `This organization has spent its $${org.monthlySpendLimitUsd.toLocaleString("en-US")} monthly security audit limit.`,
							limitUsd: org.monthlySpendLimitUsd,
							spentUsd: org.spentUsd,
							resetsAt: decodeIso(DateTime.formatIso(DateTime.makeUnsafe(org.resetsAt))),
						})
					}
					yield* refuseOversized(tenant.orgId, target.repository)
					const prior = yield* orUnavailable(store.latestPriorRun(target.id))
					const uuid = yield* random.uuidV4()
					const runId = decodeRunId(uuid)
					// Paid in AI credits: the plan must include them, with some left or overage allowed under any cap.
					yield* credits.ensure(tenant.orgId).pipe(
						Effect.catchTags({
							"@maple/backend/billing/AiCreditsExhausted": (error) =>
								Effect.fail(
									error.resetsAt === null
										? new SecurityAuditNotInPlanError({ message: error.message })
										: new SecurityAuditCreditsUsedUpError({
												message: error.message,
												resetsAt: decodeIso(new Date(error.resetsAt).toISOString()),
												capReached: error.reason === "cap_reached",
											}),
								),
							"@maple/backend/billing/AiCreditsUnavailable": (error) =>
								Effect.fail(
									new SecurityAuditPersistenceError({
										message: "Could not confirm the organization's plan with billing.",
										cause: error.message,
									}),
								),
						}),
					)
					// The target's models, else the org's, as this region serves them; fixed for the run.
					const llmSettings = yield* loadLlmSettings
					const models = securityAuditModelIds(llmSettings, {
						discovery: target.discoveryModel ?? org.discoveryModel,
						validation: target.validationModel ?? org.validationModel,
					})
					// The branch for now; the Workflow pins the commit it resolves to before any agent runs.
					const run = yield* orUnavailable(
						store.startRun({
							runId,
							targetId: target.id,
							kind: "manual",
							sourceRef: target.branch,
							workflowInstanceId: runId,
							scopePaths: payload.scopePaths ?? target.scopePaths,
							// Unbounded: the org's spend limit stops the run, not a count.
							budget: null,
							discoveryModel: models.discovery,
							validationModel: models.validation,
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
						budget: null,
						models,
						priorRunId: Option.match(prior, { onNone: () => null, onSome: (r) => r.id }),
					}
					yield* workflow
						.create(workflowPayload)
						.pipe(Effect.catch((error) => failUnstarted(store, run.id, error.message)))
					return securityAuditRunView(run)
				}).pipe(Effect.withSpan("HttpSecurityAudit.startRun")),
			)
			.handle("listRuns", ({ query }) =>
				Effect.gen(function* () {
					const { store } = yield* readAccess
					const rows = yield* orUnavailable(
						store.listRuns(query.targetId === undefined ? {} : { targetId: query.targetId }),
					)
					const runs = Arr.map(rows, securityAuditRunView)
					const findingCounts = yield* orUnavailable(
						store.countRunFindings(Arr.map(rows, (r) => r.id)),
					)
					return { runs, findingCounts }
				}).pipe(Effect.withSpan("HttpSecurityAudit.listRuns")),
			)
			.handle("getRun", ({ params }) =>
				Effect.gen(function* () {
					const { store } = yield* readAccess
					const run = yield* requireRun(store, params.runId)
					const unitCounts = yield* orUnavailable(store.countUnits(run.id))
					return {
						...securityAuditRunView(run),
						reports: run.reports,
						architectureMd: run.architectureMd,
						executionProfile: run.executionProfile,
						unitCounts,
						unitTotal: Arr.reduce(Rec.values(unitCounts), 0, (sum, n) => sum + n),
					}
				}).pipe(Effect.withSpan("HttpSecurityAudit.getRun")),
			)
			.handle("cancelRun", ({ params }) =>
				Effect.gen(function* () {
					const { tenant, store } = yield* auditAccess
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
					return securityAuditRunView(cancelled.value)
				}).pipe(Effect.withSpan("HttpSecurityAudit.cancelRun")),
			)
			.handle("listRunUnits", ({ params }) =>
				Effect.gen(function* () {
					const { store } = yield* readAccess
					const run = yield* requireRun(store, params.runId)
					const rows = yield* orUnavailable(store.listUnitSummaries(run.id))
					return { units: Arr.map(rows, securityAuditUnitView) }
				}).pipe(Effect.withSpan("HttpSecurityAudit.listRunUnits")),
			)
			.handle("listRunEvents", ({ params, query }) =>
				Effect.gen(function* () {
					const { store } = yield* readAccess
					const run = yield* requireRun(store, params.runId)
					const rows = yield* orUnavailable(
						store.listEvents(run.id, {
							limit: query.limit ?? SECURITY_AUDIT_EVENTS_DEFAULT_LIMIT,
							beforeAt: query.beforeAt,
							beforeId: query.beforeId,
						}),
					)
					return { events: Arr.map(rows, securityAuditEventView) }
				}).pipe(Effect.withSpan("HttpSecurityAudit.listRunEvents")),
			)
			.handle("listRunFindings", ({ params }) =>
				Effect.gen(function* () {
					const { store } = yield* readAccess
					const run = yield* requireRun(store, params.runId)
					const rows = yield* orUnavailable(store.listRunFindingViews(run.id))
					return { findings: Arr.map(rows, securityAuditFindingView) }
				}).pipe(Effect.withSpan("HttpSecurityAudit.listRunFindings")),
			)
			.handle("listFindings", ({ params, query }) =>
				Effect.gen(function* () {
					const { store } = yield* readAccess
					const target = yield* requireTarget(store, params.targetId)
					const rows = yield* orUnavailable(store.listFindings(target.id))
					const includeRejected = query.includeRejected === "true"
					return {
						findings: Arr.map(
							Arr.filter(rows, (row) => includeRejected || row.verdict !== "rejected"),
							securityAuditFindingView,
						),
					}
				}).pipe(Effect.withSpan("HttpSecurityAudit.listFindings")),
			)
			.handle("updateFindingStatus", ({ params, payload }) =>
				Effect.gen(function* () {
					const { tenant, store } = yield* readAccess
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
).pipe(Layer.provide(SecureRandom.layerWebCrypto))
