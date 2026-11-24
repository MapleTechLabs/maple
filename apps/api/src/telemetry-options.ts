import type { WorkerTelemetryOptions } from "@maple/infra/worker-telemetry"

/**
 * Backend errors the api always answers as a 4xx or absorbs, added to the domain's 4xx set so a
 * span that fails only with one exports `Ok`: an OAuth client's bad request (rendered as an OAuth
 * 400), a guarded transition that lost its race (remapped to a 409 or caught as a no-op), and
 * PromQL the caller wrote wrong or too big (Prometheus' 400 `bad_data` / 422 `execution`).
 * Literals keep the backend classes off the init path; the bridge test holds them to the classes.
 */
export const API_ANTICIPATED_ERROR_IDENTIFIERS: ReadonlyArray<string> = [
	"@maple/backend/errors/McpOAuthProtocolError",
	"@maple/backend/TransitionConflictError",
	"@maple/backend/promql/PromqlBadQueryError",
	"@maple/backend/promql/PromqlExecutionError",
]

export const apiTelemetryOptions: WorkerTelemetryOptions = {
	serviceName: "maple-api",
	anticipatedErrorIdentifiers: API_ANTICIPATED_ERROR_IDENTIFIERS,
}
