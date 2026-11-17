import type { WorkerTelemetryOptions } from "@maple/infra/worker-telemetry"

/**
 * Backend errors the api always answers as a 4xx or absorbs, added to the domain's 4xx set so a
 * span that fails only with one exports `Ok`: an OAuth client's bad request (rendered as an OAuth
 * 400) and a guarded transition that lost its race (remapped to a 409 or caught as a no-op).
 * Literals keep the backend classes off the init path; the bridge test holds them to the classes.
 */
export const API_ANTICIPATED_ERROR_IDENTIFIERS: ReadonlyArray<string> = [
	"@maple/backend/errors/McpOAuthProtocolError",
	"@maple/backend/TransitionConflictError",
]

export const apiTelemetryOptions: WorkerTelemetryOptions = {
	serviceName: "maple-api",
	anticipatedErrorIdentifiers: API_ANTICIPATED_ERROR_IDENTIFIERS,
}
