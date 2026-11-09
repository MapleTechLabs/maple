import { Schema } from "effect"
import { SloId } from "../primitives"
import { HttpTaggedError } from "./error-policy"

export class SloNotFoundError extends HttpTaggedError<SloNotFoundError>()(
	"@maple/http/errors/SloNotFoundError",
	{
		sloId: SloId,
		message: Schema.String,
	},
	{
		status: 404,
		code: "slo_not_found",
		title: "SLO not found",
		message: "No such SLO.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class SloValidationError extends HttpTaggedError<SloValidationError>()(
	"@maple/http/errors/SloValidationError",
	{
		message: Schema.String,
	},
	{
		status: 400,
		code: "slo_invalid",
		title: "Invalid SLO",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

export class SloPersistenceError extends HttpTaggedError<SloPersistenceError>()(
	"@maple/http/errors/SloPersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
	{
		status: 503,
		code: "slos_unavailable",
		title: "SLOs are temporarily unavailable",
		message: "SLOs are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}
