import type {
	SecurityAuditCreateTargetRequest,
	SecurityAuditFindingTriageStatus,
	SecurityAuditStartRunRequest,
} from "@maple/domain/http"
import type { SecurityAuditRunId, SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Effect } from "effect"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleAiClient, MapleInternalApiClient } from "../../../platform/api-clients"

// The `securityAudit` group on the ai Worker as Effects the Security Center's Commands wrap. Every
// failure becomes the `displayError` body, whose `code` tells the gates apart.

type Ai = typeof MapleAiClient.Service

const call = <A, E, R>(run: (api: Ai) => Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const api = yield* MapleAiClient
		return yield* run(api)
	}).pipe(Effect.mapError(toLoadFailure), Effect.result)

export const listTargets = call((api) => api.securityAudit.listTargets())

export const listRuns = (targetId?: SecurityAuditTargetId) =>
	call((api) => api.securityAudit.listRuns({ query: targetId === undefined ? {} : { targetId } }))

export const getRun = (runId: SecurityAuditRunId) =>
	call((api) => api.securityAudit.getRun({ params: { runId } }))

export const cancelRun = (runId: SecurityAuditRunId) =>
	call((api) => api.securityAudit.cancelRun({ params: { runId } }))

/** The run's coverage ledger, one lean row per unit. */
export const listRunUnits = (runId: SecurityAuditRunId) =>
	call((api) => api.securityAudit.listRunUnits({ params: { runId } }))

export const listRunEvents = (
	runId: SecurityAuditRunId,
	page: Readonly<{ limit: number; beforeAt?: number; beforeId?: string }>,
) => call((api) => api.securityAudit.listRunEvents({ params: { runId }, query: page }))

/** Rejected records ride along; the views decide whether to show them. */
export const listFindings = (targetId: SecurityAuditTargetId) =>
	call((api) =>
		api.securityAudit.listFindings({ params: { targetId }, query: { includeRejected: "true" } }),
	)

export const createTarget = (payload: SecurityAuditCreateTargetRequest) =>
	call((api) => api.securityAudit.createTarget({ payload }))

export const startRun = (targetId: SecurityAuditTargetId, payload: SecurityAuditStartRunRequest = {}) =>
	call((api) => api.securityAudit.startRun({ params: { targetId }, payload }))

export const updateFindingStatus = (
	targetId: SecurityAuditTargetId,
	fingerprint: string,
	status: SecurityAuditFindingTriageStatus,
	reason: string,
) =>
	call((api) =>
		api.securityAudit.updateFindingStatus({
			params: { targetId, fingerprint },
			payload: { status, reason },
		}),
	)

/** The org's GitHub installation and the repositories it can read: Add target's choices. */
export const githubStatus = Effect.gen(function* () {
	const api = yield* MapleInternalApiClient
	return yield* api.integrations.githubStatus()
}).pipe(Effect.mapError(toLoadFailure), Effect.result)
