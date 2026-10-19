import { Schema } from "effect"
import { HttpTaggedError } from "./error-policy"

// Failures of a metrics query the engine answered live from Google Cloud Monitoring.
// Error-only module (no effect/http-api), so the query engine can import it.

/** The query cannot run as asked: Google refused it, or it reaches too many projects or series. */
export class GcpLiveQueryRejectedError extends HttpTaggedError<GcpLiveQueryRejectedError>()(
	"@maple/http/errors/GcpLiveQueryRejectedError",
	{
		message: Schema.String,
		reason: Schema.Literals(["invalid_query", "too_many_projects", "too_many_series"]),
	},
	{
		status: 400,
		code: "gcp_live_query_rejected",
		title: "Google Cloud could not run this query",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** No Google Cloud connection with metrics on, or this deployment has no Google identity. */
export class GcpLiveQueryUnavailableError extends HttpTaggedError<GcpLiveQueryUnavailableError>()(
	"@maple/http/errors/GcpLiveQueryUnavailableError",
	{
		message: Schema.String,
	},
	{
		status: 409,
		code: "gcp_live_query_unavailable",
		title: "Google Cloud metrics are not connected",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

/** Google failed or refused the read on every project the query reaches. */
export class GcpLiveQueryFailedError extends HttpTaggedError<GcpLiveQueryFailedError>()(
	"@maple/http/errors/GcpLiveQueryFailedError",
	{
		message: Schema.String,
		failures: Schema.Array(Schema.Struct({ scope: Schema.String, message: Schema.String })),
	},
	{
		status: 502,
		code: "gcp_live_query_failed",
		title: "Google Cloud did not answer",
		retry: "backoff",
		recovery: "retry",
		exposure: "public_message",
	},
) {}

export const gcpLiveQueryHttpErrors = [
	GcpLiveQueryRejectedError,
	GcpLiveQueryUnavailableError,
	GcpLiveQueryFailedError,
] as const

export type GcpLiveQueryError = GcpLiveQueryRejectedError | GcpLiveQueryUnavailableError | GcpLiveQueryFailedError
