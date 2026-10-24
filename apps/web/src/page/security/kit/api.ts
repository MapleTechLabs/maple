import {
	ApiRequestValidationError,
	type SecurityAuditCreateTargetRequest,
	type SecurityAuditFindingTriageStatus,
	type SecurityAuditStartRunRequest,
} from "@maple/domain/http"
import type { SecurityAuditRunId, SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Effect, Schema } from "effect"
import { type LoadFailure, toLoadFailure } from "../../../data/load-failure"
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

/** The code a refused request (a 400, or a payload the client would not encode) carries. */
export const INVALID_REQUEST_CODE = "security_audit_invalid_request"

const refused = (message: string, param: string | undefined): LoadFailure => {
	const failure: LoadFailure = {
		_tag: "@maple/web/security-audit/RequestRefused",
		type: "invalid_request_error",
		code: INVALID_REQUEST_CODE,
		title: "The request was refused",
		message,
		retryable: false,
		recovery: "fix_request",
	}
	return param === undefined ? failure : { ...failure, param }
}

const isValidationError = Schema.is(ApiRequestValidationError)

/**
 * A create that failed validation, as a failure that names its field: the server's 400
 * (`<path>: Expected ...` lines) or the client's own encode of the same schema. Else the shared one.
 */
export const toCreateFailure = (error: unknown): LoadFailure => {
	if (isValidationError(error)) {
		const line = error.details[0] ?? error.message
		const param = error.param
		const message =
			param !== undefined && line.startsWith(`${param}: `) ? line.slice(param.length + 2) : line
		return refused(message, param)
	}
	if (Schema.isSchemaError(error)) {
		const [first = "", ...rest] = error.message.split("\n")
		const at = /\["(\w+)"\]/u.exec(rest.join("\n"))?.[1]
		return refused(first, at)
	}
	return toLoadFailure(error)
}

export const createTarget = (payload: SecurityAuditCreateTargetRequest) =>
	Effect.gen(function* () {
		const api = yield* MapleAiClient
		return yield* api.securityAudit.createTarget({ payload })
	}).pipe(Effect.mapError(toCreateFailure), Effect.result)

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
