import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { SessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"

export const COST_SOURCE_REQUEST_PROVIDER_MAX_LENGTH = 80
export const COST_SOURCE_REQUEST_NOTE_MAX_LENGTH = 1000

/** A provider someone wants Maple to read cost from, as they named it, and why. */
export class CostSourceRequestPayload extends Schema.Class<CostSourceRequestPayload>(
	"CostSourceRequestPayload",
)({
	provider: Schema.String.check(
		Schema.isTrimmed(),
		Schema.isMinLength(1),
		Schema.isMaxLength(COST_SOURCE_REQUEST_PROVIDER_MAX_LENGTH),
	),
	note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(COST_SOURCE_REQUEST_NOTE_MAX_LENGTH))),
}) {}

export class CostSourceRequested extends Schema.Class<CostSourceRequested>("CostSourceRequested")({
	id: Schema.String,
}) {}

export class CostSourceRequestPersistenceError extends HttpTaggedError<CostSourceRequestPersistenceError>()(
	"@maple/http/cost-source-requests/CostSourceRequestPersistenceError",
	{ message: Schema.String },
	{
		status: 503,
		code: "cost_source_request_unavailable",
		title: "Requests are temporarily unavailable",
		message: "The request could not be sent right now. Try again in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/** Asks Maple to support a cost provider it does not read yet. */
export class CostSourceRequestApiGroup extends HttpApiGroup.make("costSourceRequests")
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: CostSourceRequestPayload,
			success: CostSourceRequested,
			error: [CostSourceRequestPersistenceError],
		}),
	)
	.prefix("/internal/cost/source-requests")
	.middleware(SessionAuthorization) {}
