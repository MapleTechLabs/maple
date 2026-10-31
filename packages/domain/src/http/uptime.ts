import { Schema } from "effect"
import { UptimeMonitorId } from "../primitives"
import { HttpTaggedError } from "./error-policy"

export class UptimeMonitorNotFoundError extends HttpTaggedError<UptimeMonitorNotFoundError>()(
	"@maple/http/errors/UptimeMonitorNotFoundError",
	{
		monitorId: UptimeMonitorId,
		message: Schema.String,
	},
	{
		status: 404,
		code: "uptime_monitor_not_found",
		title: "Uptime monitor not found",
		message: "No such uptime monitor.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class UptimeMonitorValidationError extends HttpTaggedError<UptimeMonitorValidationError>()(
	"@maple/http/errors/UptimeMonitorValidationError",
	{
		message: Schema.String,
	},
	{
		status: 400,
		code: "uptime_monitor_invalid",
		title: "Invalid uptime monitor",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

export class UptimeMonitorPersistenceError extends HttpTaggedError<UptimeMonitorPersistenceError>()(
	"@maple/http/errors/UptimeMonitorPersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
	{
		status: 503,
		code: "uptime_monitors_unavailable",
		title: "Uptime monitors are temporarily unavailable",
		message: "Uptime monitors are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/** The org already has as many monitors as its plan allows (or its plan includes none). */
export class UptimeMonitorLimitReachedError extends HttpTaggedError<UptimeMonitorLimitReachedError>()(
	"@maple/http/errors/UptimeMonitorLimitReachedError",
	{
		message: Schema.String,
		/** The plan's monitor allowance; 0 when the plan includes none. */
		limit: Schema.Number,
	},
	{
		status: 402,
		code: "uptime_monitor_limit_reached",
		title: "Uptime monitor limit reached",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}
